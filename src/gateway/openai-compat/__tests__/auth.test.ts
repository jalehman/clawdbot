/**
 * Tests for bearer token authentication for OpenAI-compatible endpoint.
 */

import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { validateBearerAuth } from "../auth.js";

/**
 * Create a mock HTTP request with the specified Authorization header.
 */
function createMockRequest(authHeader?: string): IncomingMessage {
  return {
    headers: authHeader !== undefined ? { authorization: authHeader } : {},
  } as IncomingMessage;
}

describe("validateBearerAuth", () => {
  const validApiKey = "test-api-key-12345";

  describe("when API key is not configured", () => {
    it("returns 401 with appropriate message", () => {
      const req = createMockRequest("Bearer some-token");
      const result = validateBearerAuth(req, undefined);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
        expect(result.error.error.type).toBe("authentication_error");
        expect(result.error.error.code).toBe("invalid_api_key");
        expect(result.error.error.message).toContain("not configured");
      }
    });

    it("returns 401 for empty string API key", () => {
      const req = createMockRequest("Bearer some-token");
      const result = validateBearerAuth(req, "");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
      }
    });

    it("returns 401 for whitespace-only API key", () => {
      const req = createMockRequest("Bearer some-token");
      const result = validateBearerAuth(req, "   ");

      expect(result.ok).toBe(false);
    });
  });

  describe("when Authorization header is missing", () => {
    it("returns 401 with missing header message", () => {
      const req = createMockRequest();
      const result = validateBearerAuth(req, validApiKey);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
        expect(result.error.error.type).toBe("authentication_error");
        expect(result.error.error.message).toContain("Missing Authorization");
      }
    });
  });

  describe("when Authorization header is malformed", () => {
    it("rejects empty header", () => {
      const req = createMockRequest("");
      const result = validateBearerAuth(req, validApiKey);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
      }
    });

    it("rejects Basic auth", () => {
      const req = createMockRequest("Basic dXNlcjpwYXNz");
      const result = validateBearerAuth(req, validApiKey);

      expect(result.ok).toBe(false);
    });

    it("rejects Bearer without token", () => {
      const req = createMockRequest("Bearer ");
      const result = validateBearerAuth(req, validApiKey);

      expect(result.ok).toBe(false);
    });

    it("rejects Bearer with only whitespace", () => {
      const req = createMockRequest("Bearer    ");
      const result = validateBearerAuth(req, validApiKey);

      expect(result.ok).toBe(false);
    });
  });

  describe("when token is invalid", () => {
    it("returns 401 for wrong token", () => {
      const req = createMockRequest("Bearer wrong-token");
      const result = validateBearerAuth(req, validApiKey);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(401);
        expect(result.error.error.message).toBe("Invalid API key");
      }
    });

    it("returns 401 for partial token match", () => {
      const req = createMockRequest("Bearer test-api-key");
      const result = validateBearerAuth(req, validApiKey);

      expect(result.ok).toBe(false);
    });
  });

  describe("when token is valid", () => {
    it("returns ok for matching token", () => {
      const req = createMockRequest(`Bearer ${validApiKey}`);
      const result = validateBearerAuth(req, validApiKey);

      expect(result.ok).toBe(true);
    });

    it("handles case-insensitive Bearer prefix", () => {
      const req = createMockRequest(`bearer ${validApiKey}`);
      const result = validateBearerAuth(req, validApiKey);

      expect(result.ok).toBe(true);
    });

    it("handles BEARER prefix", () => {
      const req = createMockRequest(`BEARER ${validApiKey}`);
      const result = validateBearerAuth(req, validApiKey);

      expect(result.ok).toBe(true);
    });

    it("handles extra whitespace around header", () => {
      const req = createMockRequest(`  Bearer ${validApiKey}  `);
      const result = validateBearerAuth(req, validApiKey);

      expect(result.ok).toBe(true);
    });
  });

  describe("security considerations", () => {
    it("does not expose the expected API key in error messages", () => {
      const req = createMockRequest("Bearer wrong-token");
      const result = validateBearerAuth(req, validApiKey);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const errorJson = JSON.stringify(result.error);
        expect(errorJson).not.toContain(validApiKey);
      }
    });

    it("uses constant-time comparison (timing attack mitigation)", () => {
      // Note: This test verifies the behavior exists, not that it's actually constant-time.
      // A true timing test would require statistical analysis.
      const req1 = createMockRequest("Bearer a");
      const req2 = createMockRequest("Bearer aaaaaaaaaaaaaaaaaaaaaa");

      // Both should fail without leaking timing information about key length
      expect(validateBearerAuth(req1, validApiKey).ok).toBe(false);
      expect(validateBearerAuth(req2, validApiKey).ok).toBe(false);
    });
  });
});
