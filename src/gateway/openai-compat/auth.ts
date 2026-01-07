/**
 * Bearer token authentication for the OpenAI-compatible endpoint.
 *
 * Validates Authorization headers against the configured API key.
 */

import type { IncomingMessage } from "node:http";
import type { OpenAIErrorResponse } from "./types.js";

export type AuthResult =
  | { ok: true }
  | { ok: false; error: OpenAIErrorResponse; status: number };

/**
 * Extract bearer token from Authorization header.
 */
function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1] : null;
}

/**
 * Validate bearer token authentication.
 *
 * @param req - The incoming HTTP request
 * @param configuredApiKey - The API key from config (openaiCompat.apiKey)
 * @returns AuthResult indicating success or failure with OpenAI-style error
 */
export function validateBearerAuth(
  req: IncomingMessage,
  configuredApiKey: string | undefined,
): AuthResult {
  // If no API key configured, the endpoint is disabled
  if (!configuredApiKey?.trim()) {
    return {
      ok: false,
      status: 401,
      error: {
        error: {
          message:
            "OpenAI-compatible API is not configured. Set openaiCompat.apiKey in config.",
          type: "authentication_error",
          code: "invalid_api_key",
        },
      },
    };
  }

  const authHeader = req.headers.authorization;
  const token = extractBearerToken(authHeader);

  if (!token) {
    return {
      ok: false,
      status: 401,
      error: {
        error: {
          message:
            "Missing Authorization header. Expected: Authorization: Bearer <api_key>",
          type: "authentication_error",
          code: "invalid_api_key",
        },
      },
    };
  }

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(token, configuredApiKey)) {
    return {
      ok: false,
      status: 401,
      error: {
        error: {
          message: "Invalid API key",
          type: "authentication_error",
          code: "invalid_api_key",
        },
      },
    };
  }

  return { ok: true };
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Even on length mismatch, do a fake comparison to maintain constant time
    let _result = 0;
    for (let i = 0; i < a.length; i++) {
      _result |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length);
    }
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
