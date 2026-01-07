/**
 * Server-Sent Events (SSE) writer for OpenAI-compatible streaming responses.
 *
 * Formats responses according to the OpenAI chat completions streaming format.
 */

import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { OpenAIChatCompletionChunk } from "./types.js";

export type SSEWriterOptions = {
  res: ServerResponse;
  model?: string;
  /** Interval in ms for keepalive comments (0 = disabled). Default: 0 */
  keepaliveIntervalMs?: number;
};

/**
 * Create an SSE writer for streaming OpenAI-compatible responses.
 */
export function createSSEWriter(opts: SSEWriterOptions) {
  const { res, model = "clawdbot", keepaliveIntervalMs = 0 } = opts;
  const completionId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  let rolesSent = false;
  let closed = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

  // Initialize SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // Disable nginx buffering
  });

  /**
   * Write an SSE comment (keepalive).
   * Comments are lines starting with ":" and are ignored by clients
   * but keep the connection alive.
   */
  const writeKeepalive = () => {
    if (closed) return;
    res.write(": keepalive\n\n");
  };

  // Start keepalive timer if configured
  if (keepaliveIntervalMs > 0) {
    keepaliveTimer = setInterval(writeKeepalive, keepaliveIntervalMs);
  }

  /**
   * Stop the keepalive timer.
   */
  const stopKeepalive = () => {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  };

  /**
   * Write a raw SSE event.
   */
  const writeEvent = (data: string) => {
    if (closed) return;
    res.write(`data: ${data}\n\n`);
  };

  /**
   * Write the initial role chunk (assistant role announcement).
   */
  const writeRoleChunk = () => {
    if (rolesSent || closed) return;
    rolesSent = true;

    const chunk: OpenAIChatCompletionChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant" },
          finish_reason: null,
        },
      ],
    };
    writeEvent(JSON.stringify(chunk));
  };

  /**
   * Write a content delta chunk.
   */
  const writeContentChunk = (content: string) => {
    if (closed) return;
    // Ensure role is sent first
    if (!rolesSent) writeRoleChunk();

    const chunk: OpenAIChatCompletionChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content },
          finish_reason: null,
        },
      ],
    };
    writeEvent(JSON.stringify(chunk));
  };

  /**
   * Write the final chunk with finish_reason.
   */
  const writeFinishChunk = (reason: "stop" | "length" = "stop") => {
    if (closed) return;
    // Ensure role was sent
    if (!rolesSent) writeRoleChunk();

    const chunk: OpenAIChatCompletionChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: reason,
        },
      ],
    };
    writeEvent(JSON.stringify(chunk));
  };

  /**
   * Close the SSE stream with [DONE] marker.
   */
  const close = () => {
    if (closed) return;
    stopKeepalive();
    closed = true;
    writeFinishChunk("stop");
    res.write("data: [DONE]\n\n");
    res.end();
  };

  /**
   * Close the stream with an error.
   */
  const closeWithError = (error: string) => {
    if (closed) return;
    stopKeepalive();
    // Write error event before setting closed flag (writeEvent checks closed)
    const errorChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      error: {
        message: error,
        type: "server_error",
        code: "server_error",
      },
    };
    res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    closed = true;
    res.end();
  };

  /**
   * Check if the writer is closed.
   */
  const isClosed = () => closed;

  return {
    writeRoleChunk,
    writeContentChunk,
    writeFinishChunk,
    writeKeepalive,
    stopKeepalive,
    close,
    closeWithError,
    isClosed,
    completionId,
  };
}

export type SSEWriter = ReturnType<typeof createSSEWriter>;
