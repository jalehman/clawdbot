# Compaction Investigation: Context Stuck at 100%

## Executive Summary

Compaction is running, and it is persisting transcript changes.

The main issue is **measurement/persistence of token metrics**, not failed compaction mechanics:

1. `totalTokens` in session store is derived from per-run usage (`input + cacheRead + cacheWrite`) and then clamped to context window.
2. Heartbeat/tool-heavy runs produce very large `inputTokens` (often > context window), so `totalTokens` is repeatedly pinned to `contextTokens` (100%).
3. Auto-compaction increments `compactionCount`, but the auto path does **not** persist post-compaction token count (`tokensAfter`).
4. Frequent large heartbeat/tool outputs (e.g. worker events snapshots) refill prompt usage quickly, reinforcing the pinned display.

So: the 100% context display is mostly a **stuck gauge problem**, not proof compaction failed.

## End-to-End Trace

## 1) Compaction trigger and execution

- Runtime loop detects overflow and invokes `compactEmbeddedPiSessionDirect(...)` in `src/agents/pi-embedded-runner/run.ts:548`.
- Context-engine path calls ingest -> assemble -> compact in `src/agents/pi-embedded-runner/compact.ts:117`.
- Legacy engine calls SDK session compaction via `compactSession.compact(...)` in `src/context-engine/legacy-engine.ts:146`.

## 2) SDK compaction persistence behavior

In `@mariozechner/pi-coding-agent`:

- Manual compact appends compaction entry and replaces in-memory messages:
  - `appendCompaction(...)` + `agent.replaceMessages(...)` at `dist/core/agent-session.js:1126-1129`
- Auto-compaction does the same:
  - `appendCompaction(...)` + `agent.replaceMessages(...)` at `dist/core/agent-session.js:1280-1283`

This confirms compaction mutates persisted session state, not just transient memory.

## 3) Session store token accounting

Both update paths compute `totalTokens` from usage and cap it:

- `deriveSessionTotalTokens(...)` clamps to context window in `src/agents/usage.ts:131-134`
- Used in:
  - `src/auto-reply/reply/session-usage.ts:43-47`
  - `src/commands/agent/session-store.ts:70-74`

`deriveSessionTotalTokens(...)` prefers prompt-sized usage (`input + cacheRead + cacheWrite`) via `derivePromptTokens(...)` (`src/agents/usage.ts:121-126`).

Result: if usage exceeds context window, stored `totalTokens` becomes exactly `contextTokens` (100%), regardless of real post-compaction context occupancy.

## 4) Auto-compaction count vs token updates

- Auto-compaction completion updates only count via `incrementCompactionCount(...)` in:
  - `src/auto-reply/reply/agent-runner.ts:497-503`
  - `src/auto-reply/reply/followup-runner.ts:265-271`
- `incrementCompactionCount(...)` only updates tokens when `tokensAfter` is provided (`src/auto-reply/reply/session-updates.ts:255-261`).
- Auto path does not provide `tokensAfter`; manual `/compact` does (`src/auto-reply/reply/commands-compact.ts:127-129`).

So auto-compaction raises the count but leaves token gauge tied to usage-derived value.

## 5) Status display behavior

`/status` shows:

- `Context: total/context (pct)` from `entry.totalTokens` and `entry.contextTokens` (`src/auto-reply/status.ts:385-390`)
- Not true live context estimate from current transcript in normal path (`includeTranscriptUsage` is often false in command path).

## 6) Heartbeat/model staleness

Session model/provider are overwritten by the latest run metadata in `persistSessionUsageUpdate(...)` (`src/auto-reply/reply/session-usage.ts:48-50`).

If heartbeat runs MiniMax, session shows MiniMax even when main conversational model is Opus. This matches the reported stale model symptom.

## Live Validation (real session)

For session `a2512d4b-4bdd-4854-84ed-5ec5d7060f94`:

- Session store had:
  - `inputTokens: 804207`
  - `totalTokens: 204800`
  - `contextTokens: 204800`
  - `compactionCount: 6`
- Transcript had **11 compaction entries** (compaction is clearly happening).
- SDK estimate of current context from the transcript was:
  - `estimatedContextTokens: 108246`

This is direct evidence that real context was ~108k while status/store reported 204.8k/204.8k.

## Answers to the Requested Questions

1. Is compaction running and producing smaller output?

- Yes. Compaction entries are appended in transcript; SDK compaction path persists them and rebuilds messages.

2. Is compacted result persisted?

- Yes. `appendCompaction(...)` writes session history; subsequent context build uses compaction summary + kept tail.

3. Is `totalTokens` post-compaction size?

- No. It is usage-derived prompt tokens (often huge), then capped to context window.

4. Does c3a engine chain compaction then assembly correctly?

- Yes for main legacy flow (ingest -> assemble -> compact). No evidence this chain is bypassing compaction.

5. Feedback loop compaction -> refill -> compaction?

- Yes. Large heartbeat/tool outputs can quickly increase prompt usage again. Combined with clamped accounting, display appears permanently full.

6. Compaction target/ratio?

- Actual auto-compaction target comes from SDK settings:
  - threshold: `contextWindow - reserveTokens`
  - keep recent: `keepRecentTokens` (default 20k)
  - reserve: default 16384
    (`dist/core/compaction/compaction.js:60-63`, `:142-145`, `:478`)

7. Is `deriveSessionTotalTokens()` correct?

- Not for “current context occupancy”. It computes a usage proxy and clamps it; good for bounded display, bad as post-compaction truth.

## c3a-Specific Notes

- The previously fixed `compactMeta` key mismatch (`session` vs `compactSession`) was real and is resolved in current code.
- Remaining observed issue is primarily token-accounting semantics, not a new context-engine compaction failure.
- Minor c3a metadata inconsistency: runtime passes `policy` while `LegacyContextEngine` looks for `transcriptPolicy` (e.g. `src/agents/pi-embedded-runner/compact.ts:491` vs `src/context-engine/legacy-engine.ts:73`). It falls back to derived policy, so this is not the main cause here, but it is a parity risk.

## Recommended Fix

1. Separate metrics:

- Keep run-usage metrics (`input/output/cache`) as-is.
- Add/store a dedicated `contextUsedTokens` computed from current transcript context (post-compaction), not from request usage.

2. Update auto-compaction persistence:

- When auto-compaction completes, persist a post-compaction context estimate (analogous to manual `/compact` using `tokensAfter`).

3. Stop pinning occupancy gauge from usage:

- Do not drive `Context: used/limit` from usage-derived `totalTokens`.
- Use transcript-derived context usage for the context gauge.

4. Heartbeat model hygiene:

- Do not overwrite long-lived session `model`/`provider` from heartbeat runs, or store heartbeat model separately.

5. Reduce heartbeat payload inflation:

- Avoid large repeated worker snapshot payloads in normal heartbeat turns, or summarize/tool-filter before they enter transcript.
