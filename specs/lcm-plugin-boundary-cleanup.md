# LCM Plugin Boundary Cleanup

**Status:** Draft  
**Branch:** josh/lcm  
**Issue:** TBD  
**Date:** 2026-02-17

## Problem

LCM is intended to be a clean plugin that implements the `ContextEngine` interface. In practice, it has leaked into 11 core files with 424 lines of additions outside the plugin directory. A rebase of josh/lcm onto main produced conflicts in 10 of 89 commits, **none in plugin files** — all in core. This means upstream OpenClaw changes routinely collide with LCM wiring code.

### Guiding Principle

For every place LCM touches core, ask:

1. **Can LCM accomplish this using what OpenClaw already provides?** (existing hooks, the ContextEngine interface, config, etc.)
2. **If not, what's the minimal, generic extension** that any context-engine plugin could use — not just LCM?

We should never see `if (contextEngine.info.id === "lcm")` in core code. If core needs to behave differently for LCM, the ContextEngine interface should express that capability generically.

## Current Touch Points

### Summary of core files modified by LCM

| File                                           | Lines | What LCM adds                                                                                                                                                                                                 |
| ---------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.ts`                                       | +65   | Resolves context engine, passes to attempt, routes overflow compaction through `contextEngine.compact()`, calls `dispose()`                                                                                   |
| `run/attempt.ts`                               | +238  | Bootstrap, assembly, post-turn ingest + batch ingest, proactive leaf compaction trigger, proactive soft compaction, auto-compaction guard, LCM-specific message repair, 80+ lines of token estimation helpers |
| `pi-embedded-subscribe.ts`                     | +8    | Tracks `lastCompactionResult` for ingest                                                                                                                                                                      |
| `pi-embedded-subscribe.handlers.compaction.ts` | +38   | Extracts compaction result from events                                                                                                                                                                        |
| `pi-settings.ts`                               | +30   | Disables Pi auto-compaction when LCM active                                                                                                                                                                   |
| `subagent-registry.ts`                         | +16   | Manages delegated expansion grants on subagent lifecycle                                                                                                                                                      |
| `sessions-spawn-tool.ts`                       | +74   | Resolves conversation scope, creates expansion grants                                                                                                                                                         |
| `agent-runner.ts`                              | +9    | Compaction count from engine metadata                                                                                                                                                                         |
| `agent-runner-execution.ts`                    | +1    | Passes `isHeartbeat` flag                                                                                                                                                                                     |
| `agent-runner-memory.ts`                       | +1    | Passes `isHeartbeat` flag                                                                                                                                                                                     |
| `followup-runner.ts`                           | +17   | Compaction count from engine metadata                                                                                                                                                                         |
| `session-updates.ts`                           | +33   | Compaction count persistence rework                                                                                                                                                                           |
| `commands-compact.ts`                          | +90   | Routes `/compact` through context engine                                                                                                                                                                      |

## Analysis by Category

### Category A: Already fits the ContextEngine interface (minor wiring)

These are legitimate uses of the pluggable ContextEngine contract. Core _should_ call these methods — it's how the interface works. The only question is whether the call sites are clean.

**1. Overflow compaction routing** (`run.ts`)

- Core calls `contextEngine.compact()` instead of `compactEmbeddedPiSessionDirect()`
- ✅ This is correct. The ContextEngine interface defines `compact()`. The `legacyParams` bag is ugly but necessary for the legacy engine.
- **Action:** Keep as-is. The `legacyParams` bag can be deprecated once legacy engine is removed.

**2. `/compact` command routing** (`commands-compact.ts`)

- Routes manual compaction through `contextEngine.compact()`.
- ✅ Also correct use of the interface.
- **Action:** Keep. Consider extracting the lane-enqueueing to a helper so the command handler is smaller.

**3. Context assembly** (`run/attempt.ts`, ~25 lines)

- Calls `contextEngine.assemble()` after message limiting.
- ✅ Correct use of the interface. Assembly is a core ContextEngine responsibility.
- **Action:** Keep, but the `repairAssembledMessagesForLcm()` helper (which checks `contextEngine.info.id === "lcm"`) should be removed from core. If LCM's assembled messages need repair, LCM should return clean messages. See Category C.

**4. Bootstrap** (`run/attempt.ts`, ~10 lines)

- Calls `contextEngine.bootstrap()` on session file load.
- ✅ Correct — bootstrap is an optional ContextEngine method.
- **Action:** Keep.

**5. Dispose** (`run.ts`, 1 line)

- Calls `contextEngine.dispose()` in finally block.
- ✅ Correct — dispose is an optional ContextEngine method.
- **Action:** Keep.

### Category B: Needs a new ContextEngine interface method or hook

These are things LCM needs that the current interface doesn't provide, but the need is _generic_ — any sophisticated context engine would want these.

**6. Post-turn message ingest** (`run/attempt.ts`, ~50 lines)

- After each turn completes, ingest new messages into the context engine.
- The current code manually slices `messagesSnapshot`, handles batch vs single ingest, and includes auto-compaction summaries.
- **Problem:** This is 50 lines of engine-orchestration logic embedded in `attempt.ts`.
- **Proposal:** Add a new `ContextEngine` lifecycle method:
  ```typescript
  afterTurn?(params: {
    sessionId: string;
    sessionFile: string;
    prePromptMessageCount: number;
    messagesSnapshot: AgentMessage[];
    tokenBudget?: number;
    currentTokenCount?: number;
    isHeartbeat?: boolean;
    autoCompactionSummary?: string;
    legacyParams?: Record<string, unknown>;
  }): Promise<void>;
  ```
  Core calls this once after each turn. Legacy engine: no-op. LCM engine: handles ingest, leaf trigger evaluation, and proactive compaction internally.
- **Impact:** Removes ~90 lines from `attempt.ts` (ingest, leaf trigger, proactive compaction), all absorbed into `LcmContextEngine.afterTurn()`.

**7. Proactive soft compaction** (`run/attempt.ts`, ~30 lines)

- After ingest, evaluates whether leaf compaction should fire.
- Currently calls LCM-specific `evaluateLeafTrigger` and `compactLeafAsync` via type assertion.
- **Proposal:** Absorbed into `afterTurn()` above. No separate interface needed.

**8. Auto-compaction guard** (`run/attempt.ts` + `pi-settings.ts`, ~35 lines)

- Disables Pi's built-in auto-compaction when LCM is active (LCM manages its own compaction).
- Currently checks `contextEngine.info.id === "lcm"` — a plugin-specific check in core.
- **Proposal:** Add a capability flag to `ContextEngineInfo`:
  ```typescript
  type ContextEngineInfo = {
    id: string;
    name: string;
    version?: string;
    /** If true, this engine manages its own compaction; disable the host's built-in compaction. */
    ownsCompaction?: boolean;
  };
  ```
  Core checks `contextEngine.info.ownsCompaction` instead of `=== "lcm"`. The `shouldDisablePiAutoCompaction` function in `pi-settings.ts` checks the flag generically.

**9. Compaction count accounting** (`agent-runner.ts`, `followup-runner.ts`, `session-updates.ts`, ~25 lines)

- LCM produces multiple compaction passes per turn (leaf + condensed). Core only expected 0 or 1.
- Current fix: reads `compactionCount` from engine metadata and passes `amount` to `incrementCompactionCount`.
- **Proposal:** This is mostly a fix to core's assumption that compaction count is boolean. The `amount` parameter to `incrementCompactionCount` is a generic improvement. Keep but ensure the count comes from `CompactResult` or `afterTurn` return value:
  ```typescript
  type AfterTurnResult = {
    compactionsPerfomed?: number;
  };
  ```

**10. isHeartbeat passthrough** (`agent-runner-execution.ts`, `agent-runner-memory.ts`, `followup-runner.ts`, +3 lines)

- LCM needs to know if a turn is a heartbeat to skip ingest.
- This flag already exists in the run pipeline; LCM just needs it threaded deeper.
- **Proposal:** The `isHeartbeat` flag should be part of the standard run params that flow through the pipeline. These 3 one-line changes are reasonable — they're not LCM-specific, they're passing existing context to where it's needed.
- **Action:** Keep. These are tiny, correct, and would be needed by any engine.

### Category C: Should be internal to the LCM plugin

These are things that should not be in core at all.

**11. LCM message repair** (`run/attempt.ts`, `repairAssembledMessagesForLcm`, ~10 lines)

- Repairs tool_use/tool_result pairing in assembled messages.
- Checks `contextEngine.info.id === "lcm"` — hard LCM coupling in core.
- **Proposal:** Move into `LcmContextEngine.assemble()`. If LCM's assembler produces messages with broken tool pairing, it should fix them before returning. Core should never see LCM-specific repair logic.
- **Action:** Delete from `attempt.ts`, move to `src/plugins/lcm/assembler.ts`.

**12. Token estimation helpers** (`run/attempt.ts`, ~60 lines)

- `estimateTextTokens`, `estimateMessageContentTokens`, `estimateSessionTokenCount`, `LcmCompactionHooks` type.
- These are only used for LCM's proactive compaction trigger.
- **Proposal:** Absorbed into `afterTurn()` implementation inside LCM plugin. If LCM needs token estimates, it does so internally.
- **Action:** Delete from `attempt.ts`.

**13. Compaction result tracking** (`pi-embedded-subscribe.ts` + `pi-embedded-subscribe.handlers.compaction.ts`, ~46 lines)

- Tracks `lastCompactionResult` so LCM can ingest auto-compaction summaries.
- **Proposal:** Two options:
  - **(a)** Add an `after_compaction` hook payload that includes the summary text. LCM subscribes to this hook. This uses the **existing** hook system.
  - **(b)** Include compaction summary in the `afterTurn()` params (core already has the auto-compaction result).
  - Prefer **(b)** since the data flows naturally through `afterTurn()`. The `lastCompactionResult` tracking in subscribe handlers can be removed.
- **Action:** Remove from subscribe handlers, pass via `afterTurn()`.

### Category D: Delegated expansion auth (subagent lifecycle)

**14. Expansion grant management** (`subagent-registry.ts` + `sessions-spawn-tool.ts`, ~90 lines)

- When spawning subagents, creates a delegated expansion grant so the child can use `lcm_expand` on the parent's conversation.
- On subagent cleanup/sweep, revokes grants.
- Directly imports from `src/plugins/lcm/expansion-auth.ts`.
- **This is the most problematic coupling.** Core subagent lifecycle directly calls LCM internals.
- **Proposal:** Use the existing plugin hook system:
  - New hook: `subagent_spawned` (void hook, fire-and-forget)
    ```typescript
    type PluginHookSubagentSpawnedEvent = {
      parentSessionKey: string;
      childSessionKey: string;
      runTimeoutMs?: number;
    };
    ```
  - New hook: `subagent_ended` (void hook, fire-and-forget)
    ```typescript
    type PluginHookSubagentEndedEvent = {
      childSessionKey: string;
      cleanup: "delete" | "keep";
    };
    ```
  - LCM plugin registers handlers for these hooks. On `subagent_spawned`, creates the expansion grant. On `subagent_ended`, revokes it.
  - Core subagent-registry emits these hooks at the right lifecycle points. No LCM imports needed.
  - The `resolveRequesterConversationScopeId` helper in `sessions-spawn-tool.ts` moves entirely into the LCM plugin's hook handler.
- **Impact:** Removes all 90 lines of LCM code from `subagent-registry.ts` and `sessions-spawn-tool.ts`. Adds ~10 lines of hook emission in their place.

## Implementation Plan

### Phase 1: `afterTurn()` lifecycle method

- Add `afterTurn()` to `ContextEngine` interface
- Move all post-turn logic from `attempt.ts` into `LcmContextEngine.afterTurn()`:
  - Message ingest (single + batch)
  - Auto-compaction summary ingest
  - Leaf trigger evaluation
  - Proactive soft compaction
  - Token estimation
- Legacy engine: no-op implementation
- **Net effect:** ~150 lines removed from `attempt.ts`

### Phase 2: `ownsCompaction` capability flag

- Add `ownsCompaction?: boolean` to `ContextEngineInfo`
- LCM sets `ownsCompaction: true`
- `shouldDisablePiAutoCompaction` checks the flag generically
- Remove `contextEngine.info.id === "lcm"` check from `pi-settings.ts`
- **Net effect:** ~5 lines changed, removes all engine-id checks

### Phase 3: Move message repair into LCM assembler

- Move `repairAssembledMessagesForLcm()` into `assembler.ts`
- Call `sanitizeToolUseResultPairing()` inside `assemble()` before returning
- Remove from `attempt.ts`
- **Net effect:** ~15 lines removed from `attempt.ts`

### Phase 4: Subagent lifecycle hooks

- Add `subagent_spawned` and `subagent_ended` hook types
- Emit hooks from `subagent-registry.ts` and `sessions-spawn-tool.ts`
- LCM registers hook handlers for expansion grant management
- Remove direct imports of `expansion-auth.ts` from core
- **Net effect:** ~90 lines removed from core, replaced by ~10 lines of hook emissions + ~40 lines of LCM hook handlers

### Phase 5: Cleanup

- Remove dead token estimation helpers from `attempt.ts`
- Remove `lastCompactionResult` tracking from subscribe handlers (now passed via `afterTurn()`)
- Remove `LcmCompactionHooks` type from `attempt.ts`
- Audit for any remaining `"lcm"` string literals in core

## Expected Outcome

After cleanup, the core files touched by LCM should be:

| File                                           | What remains                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `run.ts`                                       | Resolve engine, pass to attempt, `compact()` on overflow, `dispose()` — all via ContextEngine interface |
| `run/attempt.ts`                               | `bootstrap()`, `assemble()`, `afterTurn()` — all via ContextEngine interface. ~30 lines total           |
| `commands-compact.ts`                          | `compact()` via ContextEngine interface                                                                 |
| `agent-runner.ts`                              | Read compaction count from standard result — generic                                                    |
| `followup-runner.ts`                           | Same compaction count handling — generic                                                                |
| `session-updates.ts`                           | `amount` param on `incrementCompactionCount` — generic improvement                                      |
| `pi-settings.ts`                               | Check `ownsCompaction` flag — generic                                                                   |
| `agent-runner-execution.ts`                    | Pass `isHeartbeat` — one line, generic                                                                  |
| `agent-runner-memory.ts`                       | Pass `isHeartbeat` — one line, generic                                                                  |
| `subagent-registry.ts`                         | Emit `subagent_ended` hook — generic                                                                    |
| `sessions-spawn-tool.ts`                       | Emit `subagent_spawned` hook — generic                                                                  |
| `pi-embedded-subscribe.ts`                     | **No LCM changes** (compaction tracking removed)                                                        |
| `pi-embedded-subscribe.handlers.compaction.ts` | **No LCM changes** (result extraction removed)                                                          |

**Zero imports from `src/plugins/lcm/` in any core file.**

Every core change is either:

- A call to a method on the `ContextEngine` interface (which any engine can implement)
- Emission of a generic lifecycle hook (which any plugin can subscribe to)
- A capability flag check (which any engine can set)
- A generic improvement (compaction count as number, isHeartbeat threading)

## Conflict Reduction Estimate

Of the 10 conflicting commits in the rebase audit:

- 6 touched core files that will no longer have LCM-specific code (attempt.ts, subscribe, subagent, followup-runner, session-updates)
- 2 were test-only conflicts (would still exist but be simpler)
- 2 were in files that correctly use the ContextEngine interface (run.ts, commands-compact.ts)

Expected conflicting commits after cleanup: **2-3** (down from 10), all at legitimate interface boundaries.
