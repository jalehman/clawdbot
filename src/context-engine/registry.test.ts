import { afterEach, describe, expect, it } from "vitest";
import type { ContextEngine } from "./types.js";
import {
  DEFAULT_CONTEXT_ENGINE_ID,
  clearContextEngineRegistry,
  registerContextEngine,
  registeredContextEngineIds,
  selectContextEngine,
} from "./registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal stub engine with the given id. */
function stubEngine(id: string): ContextEngine {
  return {
    id,
    ingest: async (p) => ({ messages: p.messages }),
    assemble: async (p) => ({ messages: p.messages }),
    compact: async () => ({ ok: true, compacted: false }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("context-engine registry", () => {
  afterEach(() => {
    clearContextEngineRegistry();
  });

  // ---- registration ----

  describe("registerContextEngine", () => {
    it("registers an engine factory", () => {
      registerContextEngine("test-engine", () => stubEngine("test-engine"));
      expect(registeredContextEngineIds()).toContain("test-engine");
    });

    it("throws on duplicate registration", () => {
      registerContextEngine("dup", () => stubEngine("dup"));
      expect(() => registerContextEngine("dup", () => stubEngine("dup"))).toThrow(
        'Context engine "dup" is already registered',
      );
    });
  });

  // ---- selection ----

  describe("selectContextEngine", () => {
    it("selects a registered engine by id", () => {
      registerContextEngine("custom", () => stubEngine("custom"));
      // Also register default so the fallback path exists
      registerContextEngine(DEFAULT_CONTEXT_ENGINE_ID, () =>
        stubEngine(DEFAULT_CONTEXT_ENGINE_ID),
      );

      const result = selectContextEngine("custom");
      expect(result.engine.id).toBe("custom");
      expect(result.resolvedId).toBe("custom");
      expect(result.fallback).toBe(false);
      expect(result.warning).toBeUndefined();
    });

    it("falls back to default when requested id is not registered", () => {
      registerContextEngine(DEFAULT_CONTEXT_ENGINE_ID, () =>
        stubEngine(DEFAULT_CONTEXT_ENGINE_ID),
      );

      const result = selectContextEngine("nonexistent");
      expect(result.engine.id).toBe(DEFAULT_CONTEXT_ENGINE_ID);
      expect(result.resolvedId).toBe(DEFAULT_CONTEXT_ENGINE_ID);
      expect(result.fallback).toBe(true);
      expect(result.warning).toMatch(/nonexistent.*not registered.*falling back/);
    });

    it("falls back to default when requested id is undefined", () => {
      registerContextEngine(DEFAULT_CONTEXT_ENGINE_ID, () =>
        stubEngine(DEFAULT_CONTEXT_ENGINE_ID),
      );

      const result = selectContextEngine(undefined);
      expect(result.engine.id).toBe(DEFAULT_CONTEXT_ENGINE_ID);
      expect(result.resolvedId).toBe(DEFAULT_CONTEXT_ENGINE_ID);
      expect(result.fallback).toBe(false);
      expect(result.warning).toBeUndefined();
    });

    it("falls back to default when requested id is null", () => {
      registerContextEngine(DEFAULT_CONTEXT_ENGINE_ID, () =>
        stubEngine(DEFAULT_CONTEXT_ENGINE_ID),
      );

      const result = selectContextEngine(null);
      expect(result.engine.id).toBe(DEFAULT_CONTEXT_ENGINE_ID);
      expect(result.resolvedId).toBe(DEFAULT_CONTEXT_ENGINE_ID);
      expect(result.fallback).toBe(false);
    });

    it("falls back to default when requested id is empty string", () => {
      registerContextEngine(DEFAULT_CONTEXT_ENGINE_ID, () =>
        stubEngine(DEFAULT_CONTEXT_ENGINE_ID),
      );

      const result = selectContextEngine("");
      expect(result.resolvedId).toBe(DEFAULT_CONTEXT_ENGINE_ID);
      expect(result.fallback).toBe(false);
    });

    it("falls back to default when requested id is whitespace only", () => {
      registerContextEngine(DEFAULT_CONTEXT_ENGINE_ID, () =>
        stubEngine(DEFAULT_CONTEXT_ENGINE_ID),
      );

      const result = selectContextEngine("   ");
      expect(result.resolvedId).toBe(DEFAULT_CONTEXT_ENGINE_ID);
      expect(result.fallback).toBe(false);
    });

    it("throws when neither requested nor default engine is registered", () => {
      expect(() => selectContextEngine("nope")).toThrow(
        /No context engine registered.*default engine "legacy" is not registered/,
      );
    });

    it("throws when no engines are registered and no id requested", () => {
      expect(() => selectContextEngine(undefined)).toThrow(
        /default engine "legacy" is not registered/,
      );
    });
  });

  // ---- introspection ----

  describe("registeredContextEngineIds", () => {
    it("returns empty array when no engines registered", () => {
      expect(registeredContextEngineIds()).toEqual([]);
    });

    it("returns all registered engine ids", () => {
      registerContextEngine("a", () => stubEngine("a"));
      registerContextEngine("b", () => stubEngine("b"));
      const ids = registeredContextEngineIds();
      expect(ids).toContain("a");
      expect(ids).toContain("b");
      expect(ids).toHaveLength(2);
    });
  });

  // ---- clearContextEngineRegistry ----

  describe("clearContextEngineRegistry", () => {
    it("removes all registered engines", () => {
      registerContextEngine("x", () => stubEngine("x"));
      expect(registeredContextEngineIds()).toHaveLength(1);
      clearContextEngineRegistry();
      expect(registeredContextEngineIds()).toHaveLength(0);
    });
  });
});
