/**
 * OpenAI chat completions request parsing and validation.
 *
 * Parses and validates incoming OpenAI-format chat completion requests,
 * converting them to Clawdbot's internal format.
 */

import type { IncomingMessage } from "node:http";
import type { OpenAIChatMessage, OpenAIErrorResponse } from "./types.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB max request body

export type ParsedRequest = {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  maxTokens?: number;
  stream: boolean;
  user?: string;
  // Extracted for session routing
  sessionKey?: string;
};

export type ParseResult =
  | { ok: true; value: ParsedRequest }
  | { ok: false; error: OpenAIErrorResponse; status: number };

/**
 * Read and parse JSON body from request.
 */
async function readJsonBody(
  req: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve({ ok: false, error: "Request body too large" });
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      if (!body.trim()) {
        resolve({ ok: false, error: "Request body is empty" });
        return;
      }
      try {
        const parsed = JSON.parse(body);
        resolve({ ok: true, value: parsed });
      } catch {
        resolve({ ok: false, error: "Invalid JSON in request body" });
      }
    });

    req.on("error", (err) => {
      resolve({ ok: false, error: `Request error: ${err.message}` });
    });
  });
}

/**
 * Validate the request body structure.
 */
function validateRequest(body: unknown): ParseResult {
  if (typeof body !== "object" || body === null) {
    return {
      ok: false,
      status: 400,
      error: {
        error: {
          message: "Request body must be a JSON object",
          type: "invalid_request_error",
          code: "invalid_request",
        },
      },
    };
  }

  const req = body as Record<string, unknown>;

  // Validate messages array (required)
  if (!Array.isArray(req.messages)) {
    return {
      ok: false,
      status: 400,
      error: {
        error: {
          message: "'messages' is required and must be an array",
          type: "invalid_request_error",
          code: "invalid_request",
        },
      },
    };
  }

  if (req.messages.length === 0) {
    return {
      ok: false,
      status: 400,
      error: {
        error: {
          message: "'messages' array must not be empty",
          type: "invalid_request_error",
          code: "invalid_request",
        },
      },
    };
  }

  // Validate each message
  const messages: OpenAIChatMessage[] = [];
  for (let i = 0; i < req.messages.length; i++) {
    const msg = req.messages[i];
    if (typeof msg !== "object" || msg === null) {
      return {
        ok: false,
        status: 400,
        error: {
          error: {
            message: `messages[${i}] must be an object`,
            type: "invalid_request_error",
            code: "invalid_request",
          },
        },
      };
    }

    const msgObj = msg as Record<string, unknown>;
    const role = msgObj.role;
    const content = msgObj.content;

    if (!["system", "user", "assistant"].includes(String(role))) {
      return {
        ok: false,
        status: 400,
        error: {
          error: {
            message: `messages[${i}].role must be 'system', 'user', or 'assistant'`,
            type: "invalid_request_error",
            code: "invalid_request",
          },
        },
      };
    }

    if (typeof content !== "string") {
      return {
        ok: false,
        status: 400,
        error: {
          error: {
            message: `messages[${i}].content must be a string`,
            type: "invalid_request_error",
            code: "invalid_request",
          },
        },
      };
    }

    messages.push({
      role: role as "system" | "user" | "assistant",
      content,
      name: typeof msgObj.name === "string" ? msgObj.name : undefined,
    });
  }

  // Validate optional fields
  const model =
    typeof req.model === "string" && req.model.trim()
      ? req.model.trim()
      : "clawdbot";

  const temperature =
    typeof req.temperature === "number" ? req.temperature : undefined;
  const maxTokens =
    typeof req.max_tokens === "number" ? req.max_tokens : undefined;
  const stream = req.stream !== false; // Default to streaming
  const user = typeof req.user === "string" ? req.user : undefined;

  return {
    ok: true,
    value: {
      model,
      messages,
      temperature,
      maxTokens,
      stream,
      user,
      sessionKey: user, // Use user field for session routing if provided
    },
  };
}

/**
 * Parse an incoming OpenAI chat completions request.
 */
export async function parseOpenAIChatRequest(
  req: IncomingMessage,
): Promise<ParseResult> {
  // Check Content-Type
  const contentType = req.headers["content-type"] ?? "";
  if (!contentType.includes("application/json")) {
    return {
      ok: false,
      status: 415,
      error: {
        error: {
          message: "Content-Type must be application/json",
          type: "invalid_request_error",
          code: "invalid_request",
        },
      },
    };
  }

  // Read body
  const bodyResult = await readJsonBody(req);
  if (!bodyResult.ok) {
    return {
      ok: false,
      status: 400,
      error: {
        error: {
          message: bodyResult.error,
          type: "invalid_request_error",
          code: "invalid_request",
        },
      },
    };
  }

  // Validate structure
  return validateRequest(bodyResult.value);
}

/**
 * Convert OpenAI messages array to a single Clawdbot message string.
 *
 * For simplicity, we concatenate messages with role prefixes.
 * The most recent user message becomes the primary input.
 */
export function messagesToClawdbotFormat(messages: OpenAIChatMessage[]): {
  message: string;
  systemPrompt?: string;
} {
  // Extract system message if present
  const systemMessages = messages.filter((m) => m.role === "system");
  const systemPrompt = systemMessages.map((m) => m.content).join("\n\n");

  // Get the last user message as the primary input
  const userMessages = messages.filter((m) => m.role === "user");
  const lastUserMessage = userMessages[userMessages.length - 1];

  if (!lastUserMessage) {
    // Fallback: use all non-system content
    const nonSystem = messages.filter((m) => m.role !== "system");
    return {
      message: nonSystem.map((m) => m.content).join("\n"),
      systemPrompt: systemPrompt || undefined,
    };
  }

  return {
    message: lastUserMessage.content,
    systemPrompt: systemPrompt || undefined,
  };
}
