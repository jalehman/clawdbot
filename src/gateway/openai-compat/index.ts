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
import { loadSessionStore, resolveStorePath } from "../../config/sessions.js";
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
  registerVoiceSession,
  releaseVoiceSessionLock,
  tryAcquireVoiceSessionLock,
  type VoiceSessionInfo,
} from "./voice-session.js";
import {
  acquirePreWarmedSessionWithSync,
  isPoolEnabled,
  toVoiceSessionInfo,
} from "./voice-session-pool.js";

/**
 * Default system prompt for voice sessions.
 * Instructs the agent to acknowledge requests before tool calls to prevent
 * silence during processing, improving conversational UX.
 */
export const DEFAULT_VOICE_SYSTEM_PROMPT = `You are in VOICE MODE. Follow these rules strictly:

1. When a request requires tool calls, ALWAYS start your response with a brief acknowledgment ENDING WITH "..." (literal ellipsis).
2. The ellipsis signals you're still working. Example: "Let me check that..." or "One moment..."
3. After the acknowledgment, perform tool calls and continue your response with the results.
4. This MUST be a single continuous response - acknowledge, tool call, then results - NOT separate messages.
5. Keep total response under 30 seconds of spoken delivery.

CRITICAL: Your acknowledgment MUST end with "..." to maintain the audio stream while tools run.

Example:
User: "What's on my calendar today?"
You: "Let me check your calendar..." [tool calls happen here] "You have 3 meetings today: a standup at 9, lunch at noon, and a review at 3."`;

/**
 * Voice mode message wrapper.
 * Wraps user messages with voice instructions to ensure they appear
 * immediately before the query, maximizing model compliance.
 */
export const VOICE_MESSAGE_WRAPPER = `[VOICE MODE - READ BEFORE RESPONDING]
1. If tool calls needed: start with brief acknowledgment ending in "..." BEFORE any tool use
2. Format response as natural speech - NO bullets, lists, headers, or markdown
3. Keep it conversational and concise, as if speaking aloud
Example: "Let me check..." [tool calls] "You have three meetings tomorrow: a standup at 9, then lunch with Sarah at noon, and a project review at 3."
[END VOICE INSTRUCTIONS]

`;

/**
 * Buffer words to stream immediately for voice mode.
 * These fill silence while the agent processes tool calls.
 * All end with ellipsis to signal continuation.
 */
export const VOICE_BUFFER_WORDS = [
  "Let me check on that...",
  "One moment...",
  "Let me look into that...",
  "Give me just a second...",
  "Let me see...",
  "Hang on...",
  "Let me find that for you...",
  "One sec...",
  "Hmm...",
  "Um...",
  "Hmm, let me see...",
  "Um, one moment...",
  "Hmm, let me check...",
];

/**
 * Get a random buffer word for voice mode.
 */
export function getRandomBufferWord(): string {
  return VOICE_BUFFER_WORDS[Math.floor(Math.random() * VOICE_BUFFER_WORDS.length)];
}

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
    opts?: { lane?: string; extraSystemPrompt?: string; isVoiceMode?: boolean },
  ): Promise<void> {
    const runId = randomUUID();
    const t0 = performance.now();
    log.info(`[LATENCY:${runId}] t0: Request received`);

    // Look up session ID from store - voice sessions must use their pre-warmed session
    const cfg = getConfig();
    const storePath = resolveStorePath(cfg.session?.store);
    const sessionStore = loadSessionStore(storePath);
    const sessionEntry = sessionStore[sessionKey];
    const sessionId = sessionEntry?.sessionId ?? randomUUID();
    log.info(
      `handleStreamingRequest: sessionKey=${sessionKey} foundSessionId=${sessionEntry?.sessionId ?? "none"} using=${sessionId}`,
    );

    // For voice mode, enable keepalive to prevent ElevenLabs timeout during processing.
    // SSE comments (": keepalive\n\n") are ignored by clients but keep connection alive.
    const keepaliveIntervalMs = opts?.isVoiceMode ? 1000 : 0;
    const sseWriter = createSSEWriter({ res, model, keepaliveIntervalMs });

    // For voice mode, immediately stream a buffer word to fill silence
    // while the agent processes tool calls.
    // IMPORTANT: Track agent text separately from buffer word injection.
    // The agent's evt.data.text is accumulated text starting from 0,
    // NOT including our buffer word. Don't confuse the two!
    if (opts?.isVoiceMode) {
      const bufferWord = getRandomBufferWord();
      const t1 = performance.now();
      log.info(
        `[LATENCY:${runId}] t1: Buffer word sent (+${(t1 - t0).toFixed(2)}ms): "${bufferWord}"`,
      );
      sseWriter.writeContentChunk(bufferWord + " ");
      // Don't add to agentLastText - buffer is separate from agent output
    }

    // Track agent's accumulated text for delta calculation (starts at 0)
    let agentLastText = "";
    let firstAgentEventTime: number | null = null;
    let firstChunkSentTime: number | null = null;

    // Register run context for event routing
    registerAgentRunContext(runId, { sessionKey });

    // Subscribe to agent events for this run
    const unsubscribe = onAgentEvent((evt: AgentEventPayload) => {
      if (evt.runId !== runId) return;
      if (sseWriter.isClosed()) return;

      // Handle streaming text from agent
      if (evt.stream === "assistant" && typeof evt.data?.text === "string") {
        if (firstAgentEventTime === null) {
          firstAgentEventTime = performance.now();
          log.info(
            `[LATENCY:${runId}] t3: First agent event (+${(firstAgentEventTime - t0).toFixed(2)}ms)`,
          );
        }

        const newText = evt.data.text;
        // Calculate delta (new content since agent's last update)
        // Note: agentLastText tracks the agent's accumulated text only,
        // NOT including our injected buffer word
        if (newText.length > agentLastText.length) {
          const delta = newText.slice(agentLastText.length);
          agentLastText = newText;
          sseWriter.writeContentChunk(delta);

          if (firstChunkSentTime === null) {
            firstChunkSentTime = performance.now();
            log.info(
              `[LATENCY:${runId}] t4: First chunk sent (+${(firstChunkSentTime - t0).toFixed(2)}ms, delta from agent event: +${(firstChunkSentTime - firstAgentEventTime).toFixed(2)}ms)`,
            );
          }
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
      const t2 = performance.now();
      log.info(
        `[LATENCY:${runId}] t2: Calling agentCommand (+${(t2 - t0).toFixed(2)}ms): sessionId=${sessionId} lane=${opts?.lane ?? "none"} extraPrompt=${opts?.extraSystemPrompt ? "yes" : "no"} msg=${message.slice(0, 30)}...`,
      );
      await agentCommand(
        {
          message,
          sessionId,
          runId,
          messageProvider: "openai-compat",
          abortSignal,
          lane: opts?.lane,
          extraSystemPrompt: opts?.extraSystemPrompt,
        },
        runtime,
        deps,
      );
      const tEnd = performance.now();
      log.info(
        `[LATENCY:${runId}] tEnd: agentCommand completed (+${(tEnd - t0).toFixed(2)}ms, agent duration: ${(tEnd - t2).toFixed(2)}ms)`,
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
    opts?: { lane?: string; extraSystemPrompt?: string },
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
          lane: opts?.lane,
          extraSystemPrompt: opts?.extraSystemPrompt,
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

    // Log incoming request details for debugging
    const voiceHeaderValue = req.headers["x-clawdbot-voice-session"];
    log.info(
      `[request] model=${model} stream=${stream} user=${user ?? "none"} ` +
        `voiceHeader=${voiceHeaderValue ?? "none"} ` +
        `userAgent=${req.headers["user-agent"]?.slice(0, 50) ?? "none"} ` +
        `msgCount=${messages.length} firstMsg=${messages[0]?.content?.toString().slice(0, 50) ?? "empty"}...`,
    );

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
        // Try to use a pre-warmed session first (if pool is enabled)
        if (isPoolEnabled()) {
          const preWarmed = await acquirePreWarmedSessionWithSync(
            baseSessionKey,
            cfg,
          );
          if (preWarmed) {
            voiceSession = toVoiceSessionInfo(preWarmed);
            sessionKey = voiceSession.ephemeralSessionKey;
            effectiveModel = voiceSession.model;
            // Register in active sessions so subsequent requests reuse it
            registerVoiceSession(voiceSession);
            log.info(
              `Voice session ${voiceSession.voiceSessionId}: using pre-warmed session ${sessionKey} with model ${effectiveModel}`,
            );
          }
        }

        // Fall back to creating on-demand if no pre-warmed session available
        if (!voiceSession) {
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
        }
      } catch (err) {
        log.warn(
          `Failed to create voice session, falling back to main: ${err}`,
        );
      }
    }

    // Try to acquire lock for voice session to prevent concurrent requests
    const voiceSessionId = voiceSession?.voiceSessionId;
    if (voiceSessionId && !tryAcquireVoiceSessionLock(voiceSessionId)) {
      log.warn(
        `Voice session ${voiceSessionId} is busy, rejecting concurrent request`,
      );
      sendError(res, 429, {
        error: {
          message: "Voice session is busy processing another request",
          type: "server_error",
          code: "server_error",
        },
      });
      return true;
    }

    try {
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
      // Voice requests get their own lane to avoid blocking on main session runs
      const lane = isVoiceMode ? "voice" : undefined;

      // Build voice system prompt if in voice mode
      // Use configured prompt, or default, or disabled if empty string
      let extraSystemPrompt: string | undefined;
      let effectiveMessage = message;
      if (isVoiceMode) {
        const configuredPrompt = openaiCompatConfig?.voiceSystemPrompt;
        if (configuredPrompt === "") {
          // Explicitly disabled
          extraSystemPrompt = undefined;
        } else {
          extraSystemPrompt = configuredPrompt ?? DEFAULT_VOICE_SYSTEM_PROMPT;
        }
        if (extraSystemPrompt) {
          log.info(
            `Voice mode: injecting voice system prompt (${extraSystemPrompt.length} chars)`,
          );
        }
        // Wrap the message with voice instructions for maximum prominence
        effectiveMessage = VOICE_MESSAGE_WRAPPER + message;
        log.info(`Voice mode: wrapped message with voice instructions`);
      }

      if (stream) {
        await handleStreamingRequest(
          res,
          effectiveMessage,
          sessionKey,
          effectiveModel,
          abortController.signal,
          { lane, extraSystemPrompt, isVoiceMode },
        );
      } else {
        await handleNonStreamingRequest(
          res,
          effectiveMessage,
          sessionKey,
          effectiveModel,
          abortController.signal,
          { lane, extraSystemPrompt },
        );
      }
    } finally {
      // Release voice session lock
      if (voiceSessionId) {
        releaseVoiceSessionLock(voiceSessionId);
      }
    }

    return true;
  };
}

export type OpenAICompatRequestHandler = ReturnType<
  typeof createOpenAICompatHandler
>;
