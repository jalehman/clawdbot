/**
 * Tests for SSE streaming response in OpenAI format.
 */

import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createSSEWriter } from "../sse-writer.js";

/**
 * Create a mock ServerResponse that captures writes.
 */
function createMockResponse(): {
  res: ServerResponse;
  writes: string[];
  headers: Record<string, string | number>;
  statusCode: number;
  ended: boolean;
} {
  const writes: string[] = [];
  const headers: Record<string, string | number> = {};
  let statusCode = 200;
  let ended = false;

  const res = {
    writeHead: vi.fn((code: number, hdrs?: Record<string, string | number>) => {
      statusCode = code;
      if (hdrs) {
        Object.assign(headers, hdrs);
      }
    }),
    write: vi.fn((data: string) => {
      writes.push(data);
      return true;
    }),
    end: vi.fn(() => {
      ended = true;
    }),
    setHeader: vi.fn((name: string, value: string | number) => {
      headers[name] = value;
    }),
  } as unknown as ServerResponse;

  return { res, writes, headers, statusCode, ended };
}

describe("createSSEWriter", () => {
  describe("initialization", () => {
    it("sets correct SSE headers", () => {
      const { res } = createMockResponse();
      createSSEWriter({ res });

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      // Check specific headers
      const calledHeaders = (res.writeHead as ReturnType<typeof vi.fn>).mock
        .calls[0][1] as Record<string, string>;
      expect(calledHeaders["Content-Type"]).toBe("text/event-stream");
      expect(calledHeaders["Cache-Control"]).toContain("no-cache");
      expect(calledHeaders.Connection).toBe("keep-alive");
    });

    it("generates unique completion ID", () => {
      const { res: res1 } = createMockResponse();
      const { res: res2 } = createMockResponse();

      const writer1 = createSSEWriter({ res: res1 });
      const writer2 = createSSEWriter({ res: res2 });

      expect(writer1.completionId).toMatch(/^chatcmpl-/);
      expect(writer2.completionId).toMatch(/^chatcmpl-/);
      expect(writer1.completionId).not.toBe(writer2.completionId);
    });
  });

  describe("writeRoleChunk", () => {
    it("writes role announcement chunk", () => {
      const { res, writes } = createMockResponse();
      const writer = createSSEWriter({ res, model: "test-model" });

      writer.writeRoleChunk();

      expect(writes).toHaveLength(1);
      const chunk = JSON.parse(writes[0].replace("data: ", "").trim());
      expect(chunk.object).toBe("chat.completion.chunk");
      expect(chunk.model).toBe("test-model");
      expect(chunk.choices[0].delta.role).toBe("assistant");
      expect(chunk.choices[0].finish_reason).toBeNull();
    });

    it("only writes role chunk once", () => {
      const { res, writes } = createMockResponse();
      const writer = createSSEWriter({ res });

      writer.writeRoleChunk();
      writer.writeRoleChunk();
      writer.writeRoleChunk();

      expect(writes).toHaveLength(1);
    });
  });

  describe("writeContentChunk", () => {
    it("writes content delta", () => {
      const { res, writes } = createMockResponse();
      const writer = createSSEWriter({ res });

      writer.writeContentChunk("Hello");

      // Should have role chunk + content chunk
      expect(writes).toHaveLength(2);
      const contentChunk = JSON.parse(writes[1].replace("data: ", "").trim());
      expect(contentChunk.choices[0].delta.content).toBe("Hello");
    });

    it("auto-sends role chunk if not sent", () => {
      const { res, writes } = createMockResponse();
      const writer = createSSEWriter({ res });

      writer.writeContentChunk("Hello");

      // First chunk should be role
      const roleChunk = JSON.parse(writes[0].replace("data: ", "").trim());
      expect(roleChunk.choices[0].delta.role).toBe("assistant");
    });

    it("writes multiple content chunks", () => {
      const { res, writes } = createMockResponse();
      const writer = createSSEWriter({ res });

      writer.writeContentChunk("Hello ");
      writer.writeContentChunk("world");

      // 1 role + 2 content
      expect(writes).toHaveLength(3);
    });

    it("does not write after close", () => {
      const { res, writes } = createMockResponse();
      const writer = createSSEWriter({ res });

      writer.close();
      writer.writeContentChunk("ignored");

      // Only close chunks, no content
      expect(writes.every((w) => !w.includes('"content":"ignored"'))).toBe(
        true,
      );
    });
  });

  describe("writeFinishChunk", () => {
    it("writes finish chunk with stop reason", () => {
      const { res, writes } = createMockResponse();
      const writer = createSSEWriter({ res });

      writer.writeFinishChunk("stop");

      const finishChunk = JSON.parse(
        writes[writes.length - 1].replace("data: ", "").trim(),
      );
      expect(finishChunk.choices[0].finish_reason).toBe("stop");
      expect(finishChunk.choices[0].delta).toEqual({});
    });

    it("writes finish chunk with length reason", () => {
      const { res, writes } = createMockResponse();
      const writer = createSSEWriter({ res });

      writer.writeFinishChunk("length");

      const finishChunk = JSON.parse(
        writes[writes.length - 1].replace("data: ", "").trim(),
      );
      expect(finishChunk.choices[0].finish_reason).toBe("length");
    });
  });

  describe("close", () => {
    it("sends [DONE] marker", () => {
      const { res, writes } = createMockResponse();
      const writer = createSSEWriter({ res });

      writer.close();

      expect(writes.some((w) => w.includes("[DONE]"))).toBe(true);
      expect(res.end).toHaveBeenCalled();
    });

    it("includes finish chunk before [DONE]", () => {
      const { res, writes } = createMockResponse();
      const writer = createSSEWriter({ res });

      writer.close();

      // Should have: role, finish, [DONE]
      const doneIndex = writes.findIndex((w) => w.includes("[DONE]"));
      const finishIndex = writes.findIndex((w) =>
        w.includes('"finish_reason":"stop"'),
      );
      expect(finishIndex).toBeLessThan(doneIndex);
    });

    it("only closes once", () => {
      const { res } = createMockResponse();
      const writer = createSSEWriter({ res });

      writer.close();
      writer.close();
      writer.close();

      expect(res.end).toHaveBeenCalledTimes(1);
    });

    it("sets isClosed flag", () => {
      const { res } = createMockResponse();
      const writer = createSSEWriter({ res });

      expect(writer.isClosed()).toBe(false);
      writer.close();
      expect(writer.isClosed()).toBe(true);
    });
  });

  describe("closeWithError", () => {
    it("closes the stream and marks as closed", () => {
      const { res } = createMockResponse();
      const writer = createSSEWriter({ res });

      expect(writer.isClosed()).toBe(false);
      writer.closeWithError("Something went wrong");
      expect(writer.isClosed()).toBe(true);
      expect(res.end).toHaveBeenCalled();
    });

    it("writes error message and [DONE] marker", () => {
      const { res, writes } = createMockResponse();
      const writer = createSSEWriter({ res });

      writer.closeWithError("Test error");

      // Should have error chunk and [DONE]
      const hasError = writes.some((w) => w.includes("Test error"));
      const hasDone = writes.some((w) => w.includes("[DONE]"));

      expect(hasError).toBe(true);
      expect(hasDone).toBe(true);
    });

    it("includes error type and code in error event", () => {
      const { res, writes } = createMockResponse();
      const writer = createSSEWriter({ res });

      writer.closeWithError("Test error");

      const errorWrite = writes.find((w) => w.includes("Test error"));
      expect(errorWrite).toBeDefined();

      if (errorWrite) {
        const parsed = JSON.parse(errorWrite.replace("data: ", "").trim());
        expect(parsed.error.type).toBe("server_error");
        expect(parsed.error.code).toBe("server_error");
      }
    });
  });

  describe("chunk format compliance", () => {
    it("generates chunks with correct structure", () => {
      const { res, writes } = createMockResponse();
      const writer = createSSEWriter({ res, model: "test-model" });

      writer.writeContentChunk("test");

      for (const write of writes) {
        if (write.startsWith("data: [DONE]")) continue;

        const chunk = JSON.parse(write.replace("data: ", "").trim());
        expect(chunk).toHaveProperty("id");
        expect(chunk).toHaveProperty("object", "chat.completion.chunk");
        expect(chunk).toHaveProperty("created");
        expect(chunk).toHaveProperty("model", "test-model");
        expect(chunk).toHaveProperty("choices");
        expect(chunk.choices).toHaveLength(1);
        expect(chunk.choices[0]).toHaveProperty("index", 0);
        expect(chunk.choices[0]).toHaveProperty("delta");
        expect(chunk.choices[0]).toHaveProperty("finish_reason");
      }
    });

    it("uses SSE data: prefix format", () => {
      const { res, writes } = createMockResponse();
      const writer = createSSEWriter({ res });

      writer.writeContentChunk("test");

      for (const write of writes) {
        expect(write).toMatch(/^data: .+\n\n$/);
      }
    });

    it("uses consistent completion ID across chunks", () => {
      const { res, writes } = createMockResponse();
      const writer = createSSEWriter({ res });

      writer.writeRoleChunk();
      writer.writeContentChunk("Hello");
      writer.writeContentChunk("World");

      const ids = writes
        .filter((w) => !w.includes("[DONE]"))
        .map((w) => JSON.parse(w.replace("data: ", "").trim()).id);

      expect(new Set(ids).size).toBe(1);
    });
  });
});
