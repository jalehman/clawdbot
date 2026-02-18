// ── LCM Plugin ───────────────────────────────────────────────────────────────
// Lossless Context Management engine for OpenClaw.

export { LcmContextEngine } from "./engine.js";
export { registerLcmPlugin } from "./register.js";

export { ContextAssembler } from "./assembler.js";
export type { AssembleContextInput, AssembleContextResult } from "./assembler.js";

export { CompactionEngine } from "./compaction.js";
export type { CompactionDecision, CompactionResult, CompactionConfig } from "./compaction.js";

export { RetrievalEngine } from "./retrieval.js";
export type {
  DescribeResult,
  GrepInput,
  GrepResult,
  ExpandInput,
  ExpandResult,
} from "./retrieval.js";

// Re-export stores
export { ConversationStore, SummaryStore } from "./store/index.js";

// Re-export DB utilities
export { resolveLcmConfig } from "./db/config.js";
export type { LcmConfig } from "./db/config.js";
export { getLcmConnection, closeLcmConnection } from "./db/connection.js";
export { runLcmMigrations } from "./db/migration.js";
