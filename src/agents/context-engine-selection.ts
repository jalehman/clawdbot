import type { OpenClawConfig } from "../config/config.js";
import type { ContextEngine } from "../context-engine/types.js";
import { selectContextEngine } from "../context-engine/index.js";

export type RuntimeContextEngineSelection = {
  engine?: ContextEngine;
  resolvedId?: string;
  warning?: string;
  error?: string;
};

/**
 * Resolve the active context engine for runtime paths.
 *
 * If a pre-selected engine is supplied, it wins. Otherwise this attempts to
 * resolve from registry/config and returns selection metadata.
 */
export function resolveRuntimeContextEngine(params: {
  config?: OpenClawConfig;
  engine?: ContextEngine;
}): RuntimeContextEngineSelection {
  if (params.engine) {
    return { engine: params.engine, resolvedId: params.engine.id };
  }

  try {
    const selected = selectContextEngine(params.config?.contextEngine?.engine);
    return {
      engine: selected.engine,
      resolvedId: selected.resolvedId,
      warning: selected.warning,
    };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
