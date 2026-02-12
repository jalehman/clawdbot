import type { ContextEngine } from "./types.js";

/**
 * The engine ID used when no engine is explicitly configured, or when
 * an invalid engine is selected.  The legacy adapter (implemented in
 * a separate task) will register under this ID.
 */
export const DEFAULT_CONTEXT_ENGINE_ID = "legacy";

// ---------------------------------------------------------------------------
// Registry internals
// ---------------------------------------------------------------------------

/** Map of engine id → factory function. */
const engines = new Map<string, () => ContextEngine>();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a context engine factory.
 *
 * Factories are invoked lazily on first selection so engines can defer
 * heavy initialization until they're actually needed.
 *
 * @param id   Unique engine identifier (e.g. "legacy", "lcm").
 * @param factory  Returns a ContextEngine instance.
 */
export function registerContextEngine(id: string, factory: () => ContextEngine): void {
  if (engines.has(id)) {
    throw new Error(`Context engine "${id}" is already registered.`);
  }
  engines.set(id, factory);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** Outcome of resolving a context engine from config. */
export type ContextEngineSelection = {
  /** The resolved engine instance. */
  engine: ContextEngine;
  /** The engine id that was actually used (may differ from requested if fallback occurred). */
  resolvedId: string;
  /** True when the resolved engine differs from the requested one. */
  fallback: boolean;
  /** Human-readable explanation when fallback occurs. */
  warning?: string;
};

/**
 * Resolve the active context engine.
 *
 * Resolution order:
 * 1. If `requestedId` is provided and registered, use it.
 * 2. Otherwise fall back to {@link DEFAULT_CONTEXT_ENGINE_ID}.
 * 3. If even the default is not registered, throw — this is a programming
 *    error (the legacy adapter must always be registered at startup).
 *
 * @param requestedId  Engine id from config (may be undefined/empty/invalid).
 */
export function selectContextEngine(requestedId?: string | null): ContextEngineSelection {
  const trimmed = requestedId?.trim() || undefined;

  // --- happy path: requested engine exists ---
  if (trimmed && engines.has(trimmed)) {
    return {
      engine: engines.get(trimmed)!(),
      resolvedId: trimmed,
      fallback: false,
    };
  }

  // --- fallback to default ---
  const defaultFactory = engines.get(DEFAULT_CONTEXT_ENGINE_ID);
  if (!defaultFactory) {
    throw new Error(
      `No context engine registered for "${trimmed ?? "(none)"}" and the default ` +
        `engine "${DEFAULT_CONTEXT_ENGINE_ID}" is not registered either. ` +
        `Ensure the legacy context engine adapter is loaded at startup.`,
    );
  }

  const warning = trimmed
    ? `Context engine "${trimmed}" is not registered; falling back to "${DEFAULT_CONTEXT_ENGINE_ID}".`
    : undefined;

  return {
    engine: defaultFactory(),
    resolvedId: DEFAULT_CONTEXT_ENGINE_ID,
    fallback: !!trimmed,
    warning,
  };
}

// ---------------------------------------------------------------------------
// Introspection / testing helpers
// ---------------------------------------------------------------------------

/** Return the ids of all registered engines (snapshot). */
export function registeredContextEngineIds(): string[] {
  return Array.from(engines.keys());
}

/**
 * Remove all registered engines.
 * Intended for test isolation only — not for production use.
 */
export function clearContextEngineRegistry(): void {
  engines.clear();
}
