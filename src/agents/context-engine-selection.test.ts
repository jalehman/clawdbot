import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ContextEngine } from "../context-engine/types.js";
import {
  DEFAULT_CONTEXT_ENGINE_ID,
  clearContextEngineRegistry,
  registerContextEngine,
  registerLegacyContextEngine,
} from "../context-engine/index.js";
import { resolveRuntimeContextEngine } from "./context-engine-selection.js";

function stubEngine(id: string): ContextEngine {
  return {
    id,
    ingest: async (params) => ({ messages: params.messages, meta: params.meta }),
    assemble: async (params) => ({ messages: params.messages, meta: params.meta }),
    compact: async () => ({ ok: true, compacted: false }),
  };
}

describe("resolveRuntimeContextEngine", () => {
  afterEach(() => {
    clearContextEngineRegistry();
  });

  it("selects the legacy engine when config is unset", () => {
    registerLegacyContextEngine();

    const selection = resolveRuntimeContextEngine({ config: {} as OpenClawConfig });

    expect(selection.error).toBeUndefined();
    expect(selection.warning).toBeUndefined();
    expect(selection.engine?.id).toBe(DEFAULT_CONTEXT_ENGINE_ID);
    expect(selection.resolvedId).toBe(DEFAULT_CONTEXT_ENGINE_ID);
  });

  it("falls back to legacy with warning when configured engine is missing", () => {
    registerLegacyContextEngine();

    const selection = resolveRuntimeContextEngine({
      config: {
        contextEngine: {
          engine: "missing-engine",
        },
      } as OpenClawConfig,
    });

    expect(selection.error).toBeUndefined();
    expect(selection.engine?.id).toBe(DEFAULT_CONTEXT_ENGINE_ID);
    expect(selection.resolvedId).toBe(DEFAULT_CONTEXT_ENGINE_ID);
    expect(selection.warning).toContain('Context engine "missing-engine" is not registered');
    expect(selection.warning).toContain(`"${DEFAULT_CONTEXT_ENGINE_ID}"`);
  });

  it("uses an explicitly supplied engine over config selection", () => {
    registerLegacyContextEngine();
    registerContextEngine("configured", () => stubEngine("configured"));
    const explicitEngine = stubEngine("explicit");

    const selection = resolveRuntimeContextEngine({
      config: {
        contextEngine: {
          engine: "configured",
        },
      } as OpenClawConfig,
      engine: explicitEngine,
    });

    expect(selection.error).toBeUndefined();
    expect(selection.warning).toBeUndefined();
    expect(selection.engine).toBe(explicitEngine);
    expect(selection.resolvedId).toBe("explicit");
  });
});
