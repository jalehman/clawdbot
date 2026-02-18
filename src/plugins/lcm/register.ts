import { registerContextEngine } from "../../context-engine/registry.js";
import { LcmContextEngine } from "./engine.js";

/**
 * Register the LCM context engine with the context-engine registry.
 *
 * The factory creates a new LcmContextEngine instance which connects
 * to PostgreSQL, runs migrations lazily, and wires together all LCM
 * components (ConversationStore, SummaryStore, ContextAssembler,
 * CompactionEngine, RetrievalEngine).
 */
export function registerLcmPlugin(): void {
  registerContextEngine("lcm", () => new LcmContextEngine());
}
