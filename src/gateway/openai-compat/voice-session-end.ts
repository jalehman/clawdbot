/**
 * Voice session end endpoint.
 *
 * POST /v1/voice/session/end
 *
 * Signals the end of a voice session and triggers compaction (summary written
 * back to the main session). This is a generic endpoint that can be called by
 * any voice provider (ElevenLabs webhook, Twilio, etc.).
 *
 * Accepts two request formats:
 *
 * 1. Simple format:
 *    { conversation_id?, reason?, summary? }
 *
 * 2. ElevenLabs post_call_transcription webhook format:
 *    { agent_id, conversation_id, status, transcript[], metadata?, analysis? }
 *
 * When ElevenLabs format is detected (has agent_id, conversation_id, and transcript array),
 * the transcript is automatically converted to a summary for compaction.
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
import { releasePreWarmedSession } from "./voice-session-pool.js";

/** Request body for ending a voice session (simple format). */
export type VoiceSessionEndRequest = {
  /** Optional: specific voice session ID to end. If omitted, ends the single active session. */
  conversation_id?: string;
  /** Optional: reason for ending the session. */
  reason?: string;
  /** Optional: pre-generated summary from the voice provider. */
  summary?: string;
};

/** ElevenLabs transcript entry. */
export type ElevenLabsTranscriptEntry = {
  role: "user" | "agent";
  message: string;
  time_in_call_secs?: number;
  tool_calls?: unknown[];
  tool_results?: unknown[];
};

/** ElevenLabs post_call_transcription webhook payload. */
export type ElevenLabsWebhookPayload = {
  agent_id: string;
  conversation_id: string;
  status: "initiating" | "in-progress" | "processing" | "done" | "failed";
  transcript: ElevenLabsTranscriptEntry[];
  metadata?: Record<string, unknown>;
  analysis?: {
    call_successful?: boolean;
    transcript_summary?: string;
    evaluation_criteria_results?: Record<string, unknown>;
    data_collection_results?: Record<string, unknown>;
    custom_prompts?: Record<string, unknown>;
  };
};

/**
 * Check if the request body is ElevenLabs webhook format.
 */
function isElevenLabsFormat(body: unknown): body is ElevenLabsWebhookPayload {
  if (typeof body !== "object" || body === null) return false;
  const obj = body as Record<string, unknown>;
  return (
    typeof obj.agent_id === "string" &&
    typeof obj.conversation_id === "string" &&
    Array.isArray(obj.transcript)
  );
}

/**
 * Convert ElevenLabs transcript to a summary string.
 */
function formatElevenLabsTranscript(payload: ElevenLabsWebhookPayload): string {
  // Prefer analysis summary if available
  if (payload.analysis?.transcript_summary) {
    return payload.analysis.transcript_summary;
  }

  // Otherwise format the transcript
  const lines = payload.transcript.map((entry) => {
    const role = entry.role === "user" ? "User" : "Agent";
    return `${role}: ${entry.message}`;
  });

  return lines.join("\n");
}

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
 * Returns the raw parsed JSON to allow format detection.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
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
 * Normalize request body to VoiceSessionEndRequest format.
 * Accepts both simple format and ElevenLabs webhook format.
 */
function normalizeRequestBody(
  body: unknown,
  log: { info: (msg: string) => void },
): VoiceSessionEndRequest {
  // Check if this is ElevenLabs format
  if (isElevenLabsFormat(body)) {
    log.info(
      `Detected ElevenLabs webhook format: agent_id=${body.agent_id}, transcript=${body.transcript.length} entries`,
    );
    return {
      conversation_id: body.conversation_id,
      summary: formatElevenLabsTranscript(body),
      reason: body.status === "failed" ? "call_failed" : undefined,
    };
  }

  // Simple format - return as-is with defaults
  const simple = body as VoiceSessionEndRequest;
  return {
    conversation_id: simple.conversation_id,
    summary: simple.summary,
    reason: simple.reason,
  };
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

    // Parse request body and normalize to simple format
    // Accepts both simple format and ElevenLabs webhook format
    let body: VoiceSessionEndRequest;
    try {
      const rawBody = await readJsonBody(req);
      body = normalizeRequestBody(rawBody, log);
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

      // Trigger async session rotation if this was a pre-warmed session.
      // Pre-warmed session IDs start with "prewarm-".
      if (session.voiceSessionId.startsWith("prewarm-")) {
        // Fire-and-forget: don't block the response
        releasePreWarmedSession(session.voiceSessionId).catch((err) => {
          log.warn(`Failed to rotate pre-warmed session: ${err}`);
        });
      }
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
