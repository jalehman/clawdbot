# Context Engine Boundary Audit

**Date:** 2026-02-16
**Branch:** `josh/lcm`
**Commit:** `cd8de414f` (Fix compaction count persistence fallback and add tracing)

## Background

OpenClaw's plugin system was designed to make the context engine pluggable. The `ContextEngine` interface defines extension points throughout the core, with two implementations:

- **legacy** — the default built-in behavior (Pi's session-level compaction)
- **lcm** — Lossless Context Management, a plugin that independently summarizes and stores messages in SQLite for later retrieval

The original goal: all LCM-related logic lives inside `src/plugins/lcm/`, and the core only interacts with it through the `ContextEngine` interface. This audit evaluates how well that design has held up.

---

## ContextEngine Interface

**Defined at:** `src/context-engine/types.ts:56`

### Methods

| Method         | Purpose                                        |
| -------------- | ---------------------------------------------- |
| `info`         | Metadata (`id`, `name`, `version?`)            |
| `bootstrap?`   | Optional session initialization                |
| `ingest`       | Ingest a single message into the context store |
| `ingestBatch?` | Ingest multiple messages at once               |
| `assemble`     | Build the message array the model will see     |
| `compact`      | Run compaction (manual or threshold-triggered) |
| `dispose?`     | Cleanup                                        |

### Registry & Resolution

- Registration and lookup: `src/context-engine/registry.ts`
- Engine selection via config slot `plugins.slots.contextEngine`: `registry.ts:51-64`
- Both legacy + lcm registered at init: `src/context-engine/init.ts:1-23`

### Assessment

The interface covers the **compaction lifecycle** (bootstrap → ingest → assemble → compact → dispose) cleanly. However, it does **not** cover LCM's retrieval features:

- `getRetrieval()` — querying stored summaries/messages
- `getConversationStore()` — conversation scoping
- `getSummaryStore()` — direct summary access
- Expansion auth/policy — cross-session expansion controls

These are exposed as extra methods on `LcmContextEngine` (`src/plugins/lcm/engine.ts:857-865`) that are **not part of the interface**, forcing core code to cast or import LCM internals directly.

**Open question:** These retrieval features have no corollary in the legacy context system. It's unclear whether the interface should be extended to accommodate them (with legacy returning no-ops), or whether a separate retrieval interface/facade is more appropriate.

---

## Compaction Codepath Trace

### Trigger 1: Overflow (proactive compaction)

| Step | Location                           | Action                                                                                                    |
| ---- | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1    | Pi compaction fires                | `pi-extensions/compaction-safeguard.ts:162` generates rich structured summary                             |
| 2    | Event captured                     | `pi-embedded-subscribe.handlers.compaction.ts:10,73` stores `{ summary, tokensBefore, firstKeptEntryId }` |
| 3    | Summary ingested as raw message    | `attempt.ts:1155-1166` — `contextEngine.ingestBatch([{ role: "user", content: summary }])`                |
| 4    | LCM proactive compaction fires     | `attempt.ts:1216` with `compactionTarget: "threshold"`                                                    |
| 5    | LCM leaf pass re-summarizes        | `compaction.ts:165,336,340` — Pi's ~13K summary compressed to ≤1,200 tokens                               |
| 6    | `assemble()` renders LCM's version | `assembler.ts:204,442` — Pi's original is gone                                                            |

**Result:** Two LLM calls. Pi's rich summary is double-compressed to ≤1/10th its size. Both continuation and retrieval use the degraded version.

**Note:** A guard at `pi-settings.ts:42` attempts to disable Pi auto-compaction when LCM is active, so this path is partly a fallback — but it still fires.

### Trigger 2: Manual `/compact`

| Step | Location                         | Action                                                                                 |
| ---- | -------------------------------- | -------------------------------------------------------------------------------------- |
| 1    | Command entry                    | `commands-compact.ts:52`                                                               |
| 2    | Calls context engine             | `commands-compact.ts:97,125` — `contextEngine.compact()` with `manualCompaction: true` |
| 3    | LCM manual branch                | `engine.ts:719,792` — `this.compaction.compact(... force: true)`                       |
| 4    | LCM summarizes raw messages      | `compaction.ts:340,418` via `summarize.ts:116`                                         |
| 5    | `assemble()` renders LCM summary | Same assembly path as overflow                                                         |

**Result:** No Pi summary is generated at all. LCM summarizes the raw messages itself with its tight token caps (≤1,200 tokens). One LLM call, but using LCM's terse prompt and budget instead of Pi's rich structured format.

### Convergence

- Both paths converge only at assembly time (`assembler.ts:250`)
- The ingestion paths are completely different
- Neither path gives the model Pi's rich structured summary

---

## Boundary Violations

### High Severity — Direct plugin imports in core

These files import LCM internals directly, bypassing the `ContextEngine` interface:

| File                                                      | What's imported                      | Category   |
| --------------------------------------------------------- | ------------------------------------ | ---------- |
| `src/agents/tools/lcm-grep-tool.ts:3,94-95`               | LCM retrieval store                  | Very leaky |
| `src/agents/tools/lcm-describe-tool.ts:3,51-52`           | LCM retrieval store                  | Very leaky |
| `src/agents/tools/lcm-expand-tool.ts:3,11-17,152-153`     | Expansion auth, policy, retrieval    | Very leaky |
| `src/agents/tools/lcm-expand-tool.delegation.ts:2,13,219` | Expansion auth                       | Very leaky |
| `src/agents/tools/lcm-conversation-scope.ts:1,41`         | Conversation store                   | Very leaky |
| `src/agents/tools/sessions-spawn-tool.ts:3,16,20,97,108`  | `resolveLcmConfig`, expansion grants | Very leaky |
| `src/agents/subagent-registry.ts:8`                       | LCM internals                        | Very leaky |

**Root cause:** The `ContextEngine` interface has no retrieval/query methods. Core tooling must reach into the plugin to wire up grep/expand/describe functionality.

### Medium Severity — Hard-coded `"lcm"` checks in core

| File:Line                   | What it does                                        | Category |
| --------------------------- | --------------------------------------------------- | -------- |
| `attempt.ts:221`            | Repair helper only runs for `"lcm"`                 | Leaky    |
| `attempt.ts:1189`           | Proactive compaction guarded by `info.id === "lcm"` | Leaky    |
| `pi-settings.ts:42`         | Disables Pi auto-compaction when engine is `"lcm"`  | Leaky    |
| `openclaw-tools.ts:167`     | Tool registration branched on engine name           | Leaky    |
| `lcm-grep-tool.ts:88`       | Activation check                                    | Leaky    |
| `lcm-describe-tool.ts:45`   | Activation check                                    | Leaky    |
| `lcm-expand-tool.ts:146`    | Activation check                                    | Leaky    |
| `sessions-spawn-tool.ts:93` | Activation check                                    | Leaky    |

### Low Severity — Acceptable coupling

| File                          | What                          | Category                       |
| ----------------------------- | ----------------------------- | ------------------------------ |
| `context-engine/init.ts:2,23` | LCM registration at bootstrap | Acceptable for built-in bundle |
| `plugins/slots.ts:19`         | Config slot mentions lcm      | Expected                       |
| `config/schema.help.ts:254`   | Schema help text              | Expected                       |

---

## Summary

The original pluggable context engine design holds for the **compaction lifecycle** (ingest → assemble → compact). The `ContextEngine` interface is clean for these operations, and both legacy and LCM implement it.

However, LCM grew **retrieval features** (grep, expand, describe, conversation scoping, cross-session expansion auth) that have no representation in the interface and no corollary in the legacy context system. This forced core code to import LCM internals directly, creating significant boundary leakage.

### Counts

- **High severity leaks:** 7 files with direct plugin imports
- **Medium severity leaks:** 8 locations with hard-coded `"lcm"` checks
- **Low/acceptable:** 3 locations (registration, config)

### Open Questions

1. Should the `ContextEngine` interface be extended with optional retrieval methods (legacy returns undefined/no-ops)?
2. Should retrieval be a separate interface/facade that plugins can register independently?
3. Should the LCM tools be moved into the plugin directory and registered via a plugin hook?
4. How do we handle the compaction problem (double compression / missing Pi summaries) without adding more boundary violations?
