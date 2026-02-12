export type {
  ContextEngine,
  ContextIngestParams,
  ContextIngestResult,
  ContextAssembleParams,
  ContextAssembleResult,
  ContextCompactParams,
  ContextCompactResult,
} from "./types.js";

export {
  DEFAULT_CONTEXT_ENGINE_ID,
  registerContextEngine,
  selectContextEngine,
  registeredContextEngineIds,
  clearContextEngineRegistry,
} from "./registry.js";
export type { ContextEngineSelection } from "./registry.js";

export { LegacyContextEngine, registerLegacyContextEngine } from "./legacy-engine.js";
export type {
  LegacyCompactSession,
  LegacyContextEngineMeta,
  LegacySessionCompactResult,
} from "./legacy-engine.js";
