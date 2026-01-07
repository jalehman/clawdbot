/**
 * Voice session end endpoint.
 *
 * POST /v1/voice/session/end
 *
 * Signals the end of a voice session and triggers compaction (summary written
 * back to the main session). This is a generic endpoint that can be called by
 * any voice provider (ElevenLabs webhook, Twilio, etc.).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClawdbotConfig } from "../../config/types.js";
import { validateBearerAuth } from "./auth.js";
import type { OpenAIErrorResponse } from "./types.js";
import {
  endVoiceSession,
  getVoiceSession,
  listActiveVoiceSessions,
  type VoiceSessionInfo,
} from "./voice-session.js";

/** Request body for ending a voice session. */
export type VoiceSessionEndRequest = {
  /** Optional: specific voice session ID to end. If omitted, ends the single active session. */
  conversation_id?: string;
  /** Optional: reason for ending the session. */
  reason?: string;
  /** Optional: pre-generated summary from the voice provider. */
  summary?: string;
};

/** Response from the voice session end endpoint. */
export type VoiceSessionEndResponse = {
  success: boolean;
  /** Summary of the voice conversation (if compaction occurred). */
  summary?: string;
  /** Duration of the voice session. */
  duration?: string;
  /** Number of turns in the voice session. */
  turns?: number;
  /** Error message if the operation failed. */
  error?: string;
};

export type VoiceSessionEndHandlerDeps = {
  getConfig: () => ClawdbotConfig;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  /** Optional: callback to generate a summary for the voice session. */
  generateSummary?: (sessionKey: string) => Promise<string>;
};

/**
 * Send JSON response.
 */
function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

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
 * Read and parse JSON body from request.
 */
async function readJsonBody(
  req: IncomingMessage,
): Promise<VoiceSessionEndRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        const parsed = JSON.parse(body);
        resolve(parsed ?? {});
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${err}`));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Format duration in milliseconds to a human-readable string.
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Resolve which voice session to end.
 *
 * If conversation_id is provided, find that specific session.
 * Otherwise, if there's exactly one active session, use it.
 */
function resolveVoiceSession(
  conversationId?: string,
): { ok: true; session: VoiceSessionInfo } | { ok: false; error: string } {
  if (conversationId) {
    const session = getVoiceSession(conversationId);
    if (!session) {
      return {
        ok: false,
        error: `Voice session '${conversationId}' not found`,
      };
    }
    return { ok: true, session };
  }

  // No ID provided - check for single active session
  const activeSessions = listActiveVoiceSessions();
  if (activeSessions.length === 0) {
    return { ok: false, error: "No active voice sessions" };
  }
  if (activeSessions.length > 1) {
    return {
      ok: false,
      error: `Multiple active voice sessions. Specify conversation_id: ${activeSessions.map((s) => s.voiceSessionId).join(", ")}`,
    };
  }

  return { ok: true, session: activeSessions[0] };
}

/**
 * Create the voice session end request handler.
 *
 * @returns Handler for POST /v1/voice/session/end
 */
export function createVoiceSessionEndHandler(deps: VoiceSessionEndHandlerDeps) {
  const { getConfig, log, generateSummary } = deps;

  /**
   * Handle POST /v1/voice/session/end.
   *
   * @returns true if the request was handled, false if it should pass through
   */
  return async function handleVoiceSessionEnd(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    // Check URL path
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`,
    );
    if (url.pathname !== "/v1/voice/session/end") {
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

    // Parse request body
    let body: VoiceSessionEndRequest;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      sendError(res, 400, {
        error: {
          message: String(err),
          type: "invalid_request_error",
          code: "invalid_request",
        },
      });
      return true;
    }

    log.info(
      `Voice session end request: conversation_id=${body.conversation_id ?? "(auto)"}, reason=${body.reason ?? "(none)"}`,
    );

    // Resolve which session to end
    const sessionResult = resolveVoiceSession(body.conversation_id);
    if (!sessionResult.ok) {
      sendJson(res, 404, {
        success: false,
        error: sessionResult.error,
      } as VoiceSessionEndResponse);
      return true;
    }

    const { session } = sessionResult;

    // Calculate duration for response
    const durationMs = Date.now() - session.startedAt;
    const duration = formatDuration(durationMs);

    try {
      // Determine summary source based on config
      const compactionSource = openaiCompatConfig?.compactionSource ?? "auto";
      let summaryCallback: (() => Promise<string>) | undefined;

      switch (compactionSource) {
        case "self":
          // Always generate our own summary, ignore webhook-provided one
          summaryCallback = generateSummary
            ? async () => generateSummary(session.ephemeralSessionKey)
            : undefined;
          break;
        case "webhook":
          // Require summary in request
          if (!body.summary) {
            sendJson(res, 400, {
              success: false,
              error:
                "Summary required in request body when compactionSource is 'webhook'",
            } as VoiceSessionEndResponse);
            return true;
          }
          summaryCallback = async () => body.summary as string;
          break;
        case "auto":
        default:
          // Use webhook summary if provided, else fall back to generating
          if (body.summary) {
            summaryCallback = async () => body.summary as string;
          } else if (generateSummary) {
            summaryCallback = async () =>
              generateSummary(session.ephemeralSessionKey);
          }
          break;
      }

      const result = await endVoiceSession({
        voiceSessionId: session.voiceSessionId,
        config: cfg,
        generateSummary: summaryCallback,
        log,
      });

      const response: VoiceSessionEndResponse = {
        success: true,
        duration,
        turns: session.turnCount,
        summary: result.summary,
      };

      log.info(
        `Voice session ${session.voiceSessionId} ended successfully (${duration}, ${session.turnCount} turns)`,
      );
      sendJson(res, 200, response);
    } catch (err) {
      log.error(`Failed to end voice session: ${err}`);
      sendJson(res, 500, {
        success: false,
        error: String(err),
      } as VoiceSessionEndResponse);
    }

    return true;
  };
}

export type VoiceSessionEndHandler = ReturnType<
  typeof createVoiceSessionEndHandler
>;
