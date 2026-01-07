/**
 * OpenAI-compatible chat completions endpoint handler.
 *
 * This module implements a generic OpenAI-compatible /v1/chat/completions endpoint
 * that can be used by any OpenAI-compatible client (ElevenLabs voice, LangChain, etc.).
 *
 * Key design principle: This is NOT voice-specific - it's a standard OpenAI API shim
 * for Clawdbot that can be PR'd to the main repo.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CliDeps } from "../../cli/deps.js";
import { agentCommand } from "../../commands/agent.js";
import type { ClawdbotConfig } from "../../config/config.js";
import {
  type AgentEventPayload,
  clearAgentRunContext,
  onAgentEvent,
  registerAgentRunContext,
} from "../../infra/agent-events.js";
import type { RuntimeEnv } from "../../runtime.js";
import { validateBearerAuth } from "./auth.js";
import {
  messagesToClawdbotFormat,
  parseOpenAIChatRequest,
} from "./parse-request.js";
import { createSSEWriter } from "./sse-writer.js";
import type { OpenAIChatCompletion, OpenAIErrorResponse } from "./types.js";
import {
  getOrCreateVoiceSession,
  getVoiceSessionId,
  isVoiceSessionHeader,
  type VoiceSessionInfo,
} from "./voice-session.js";

export type OpenAICompatConfig = {
  apiKey?: string;
  defaultSessionKey?: string;
};

export type OpenAICompatHandlerDeps = {
  getConfig: () => ClawdbotConfig;
  deps: CliDeps;
  runtime: RuntimeEnv;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
};

/**
 * Send JSON error response in OpenAI format.
 */
function sendError(
  res: ServerResponse,
  status: number,
  error: OpenAIErrorResponse,
) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(error));
}

/**
 * Send JSON success response.
 */
function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/**
 * Create the OpenAI-compatible request handler.
 *
 * Returns a handler function that can be plugged into the HTTP server.
 */
export function createOpenAICompatHandler(
  handlerDeps: OpenAICompatHandlerDeps,
) {
  const { getConfig, deps, runtime, log } = handlerDeps;

  /**
   * Handle a chat completions request with streaming response.
   */
  async function handleStreamingRequest(
    res: ServerResponse,
    message: string,
    sessionKey: string,
    model: string,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const runId = randomUUID();
    const sessionId = randomUUID();
    const sseWriter = createSSEWriter({ res, model });

    // Track accumulated text for building response
    let lastText = "";

    // Register run context for event routing
    registerAgentRunContext(runId, { sessionKey });

    // Subscribe to agent events for this run
    const unsubscribe = onAgentEvent((evt: AgentEventPayload) => {
      if (evt.runId !== runId) return;
      if (sseWriter.isClosed()) return;

      // Handle streaming text
      if (evt.stream === "assistant" && typeof evt.data?.text === "string") {
        const newText = evt.data.text;
        // Calculate delta (new content since last update)
        if (newText.length > lastText.length) {
          const delta = newText.slice(lastText.length);
          lastText = newText;
          sseWriter.writeContentChunk(delta);
        }
      }

      // Handle completion
      if (evt.stream === "lifecycle") {
        const phase = evt.data?.phase;
        if (phase === "end") {
          sseWriter.close();
          unsubscribe();
          clearAgentRunContext(runId);
        } else if (phase === "error") {
          const errorMsg =
            typeof evt.data?.error === "string"
              ? evt.data.error
              : "Agent error occurred";
          sseWriter.closeWithError(errorMsg);
          unsubscribe();
          clearAgentRunContext(runId);
        }
      }
    });

    // Handle client disconnect
    res.on("close", () => {
      if (!sseWriter.isClosed()) {
        unsubscribe();
        clearAgentRunContext(runId);
      }
    });

    // Handle abort
    abortSignal.addEventListener("abort", () => {
      if (!sseWriter.isClosed()) {
        sseWriter.close();
        unsubscribe();
        clearAgentRunContext(runId);
      }
    });

    try {
      // Run the agent
      await agentCommand(
        {
          message,
          sessionId,
          runId,
          messageProvider: "openai-compat",
          abortSignal,
        },
        runtime,
        deps,
      );

      // Agent completed - ensure stream is closed
      if (!sseWriter.isClosed()) {
        sseWriter.close();
      }
    } catch (err) {
      log.error(`OpenAI compat agent error: ${String(err)}`);
      if (!sseWriter.isClosed()) {
        sseWriter.closeWithError(String(err));
      }
    } finally {
      unsubscribe();
      clearAgentRunContext(runId);
    }
  }

  /**
   * Handle a chat completions request with non-streaming response.
   */
  async function handleNonStreamingRequest(
    res: ServerResponse,
    message: string,
    sessionKey: string,
    model: string,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const runId = randomUUID();
    const sessionId = randomUUID();
    const completionId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const created = Math.floor(Date.now() / 1000);

    // Track accumulated text
    let finalText = "";
    let completed = false;

    // Register run context
    registerAgentRunContext(runId, { sessionKey });

    // Collect response via events
    const responsePromise = new Promise<string>((resolve, reject) => {
      const unsubscribe = onAgentEvent((evt: AgentEventPayload) => {
        if (evt.runId !== runId) return;

        if (evt.stream === "assistant" && typeof evt.data?.text === "string") {
          finalText = evt.data.text;
        }

        if (evt.stream === "lifecycle") {
          const phase = evt.data?.phase;
          if (phase === "end") {
            completed = true;
            unsubscribe();
            resolve(finalText);
          } else if (phase === "error") {
            unsubscribe();
            reject(new Error(String(evt.data?.error ?? "Agent error")));
          }
        }
      });

      // Timeout after 5 minutes
      setTimeout(
        () => {
          if (!completed) {
            unsubscribe();
            reject(new Error("Request timed out"));
          }
        },
        5 * 60 * 1000,
      );
    });

    try {
      // Run the agent
      const agentPromise = agentCommand(
        {
          message,
          sessionId,
          runId,
          messageProvider: "openai-compat",
          abortSignal,
        },
        runtime,
        deps,
      );

      // Wait for both agent completion and response collection
      await Promise.all([agentPromise, responsePromise]);
      const responseText = await responsePromise;

      // Build non-streaming response
      const response: OpenAIChatCompletion = {
        id: completionId,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: responseText.trim(),
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          // Approximate token counts (4 chars per token)
          prompt_tokens: Math.ceil(message.length / 4),
          completion_tokens: Math.ceil(responseText.length / 4),
          total_tokens:
            Math.ceil(message.length / 4) + Math.ceil(responseText.length / 4),
        },
      };

      sendJson(res, 200, response);
    } catch (err) {
      log.error(`OpenAI compat agent error: ${String(err)}`);
      sendError(res, 500, {
        error: {
          message: String(err),
          type: "server_error",
          code: "server_error",
        },
      });
    } finally {
      clearAgentRunContext(runId);
    }
  }

  /**
   * Main request handler for /v1/chat/completions.
   *
   * @returns true if the request was handled, false if it should be passed to next handler
   */
  return async function handleOpenAICompatRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    // Check URL path
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    if (url.pathname !== "/v1/chat/completions") {
      return false;
    }

    // Only POST allowed
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const cfg = getConfig();
    const openaiCompatConfig = cfg.openaiCompat;

    // Authenticate request
    const authResult = validateBearerAuth(req, openaiCompatConfig?.apiKey);
    if (!authResult.ok) {
      sendError(res, authResult.status, authResult.error);
      return true;
    }

    // Parse request
    const parseResult = await parseOpenAIChatRequest(req);
    if (!parseResult.ok) {
      sendError(res, parseResult.status, parseResult.error);
      return true;
    }

    const { messages, model, stream, user } = parseResult.value;

    // Convert messages to Clawdbot format
    // Note: systemPrompt is available but not used yet; future enhancement for extraSystemPrompt
    const { message } = messagesToClawdbotFormat(messages);

    // Determine base session key - use user field, X-Clawdbot-Session header, or default
    const sessionHeader = req.headers["x-clawdbot-session"];
    const baseSessionKey =
      (typeof sessionHeader === "string" ? sessionHeader : undefined) ??
      user ??
      openaiCompatConfig?.defaultSessionKey ??
      "agent:main:openai-compat";

    // Check for voice session mode
    const isVoiceMode = isVoiceSessionHeader(
      req.headers as Record<string, string | string[] | undefined>,
    );
    const voiceSessionIdFromHeader = getVoiceSessionId(
      req.headers as Record<string, string | string[] | undefined>,
    );

    let sessionKey = baseSessionKey;
    let voiceSession: VoiceSessionInfo | undefined;
    let effectiveModel = model;

    // Fork to voice session if in voice mode
    if (isVoiceMode) {
      try {
        voiceSession = await getOrCreateVoiceSession({
          mainSessionKey: baseSessionKey,
          voiceSessionId: voiceSessionIdFromHeader,
          config: cfg,
          log,
        });
        sessionKey = voiceSession.ephemeralSessionKey;
        effectiveModel = voiceSession.model;
        log.info(
          `Voice session ${voiceSession.voiceSessionId}: routing to ${sessionKey} with model ${effectiveModel}`,
        );
      } catch (err) {
        log.warn(
          `Failed to create voice session, falling back to main: ${err}`,
        );
      }
    }

    log.info(
      `OpenAI compat request: model=${effectiveModel}, stream=${stream}, session=${sessionKey}${isVoiceMode ? " (voice)" : ""}`,
    );

    // Create abort controller for this request
    const abortController = new AbortController();

    // Handle abort on disconnect
    res.on("close", () => {
      abortController.abort();
      // Note: Voice session compaction is now triggered explicitly via
      // POST /v1/voice/session/end, not on connection close (which fires
      // every turn in a streaming context).
    });

    // Route to appropriate handler
    if (stream) {
      await handleStreamingRequest(
        res,
        message,
        sessionKey,
        effectiveModel,
        abortController.signal,
      );
    } else {
      await handleNonStreamingRequest(
        res,
        message,
        sessionKey,
        effectiveModel,
        abortController.signal,
      );
    }

    return true;
  };
}

export type OpenAICompatRequestHandler = ReturnType<
  typeof createOpenAICompatHandler
>;
