# LCM: Incremental Depth-Aware Condensation

## Problem

Currently incremental compaction (the auto path after each turn) only creates leaf summaries. Depth-aware condensation (d0→d1, d1→d2, etc.) only runs during `compactFullSweep` — triggered by manual `/compact` or threshold breaches. This means summaries pile up at d0 until a sweep runs.

Additionally, manual `/compact` currently uses `hardTrigger=true`, which applies `condensedMinFanoutHard` (default 2) instead of `condensedMinFanout` (default 4). This is more aggressive than intended.

## Changes

### 1. New config: `incrementalMaxDepth`

Controls how many depth levels the incremental compaction path processes beyond leaf creation.

- **Config key:** `incrementalMaxDepth` (in `CompactionConfig`)
- **Env var:** `LCM_INCREMENTAL_MAX_DEPTH`
- **Default:** `0` (current behavior — leaf passes only)
- **Values:**
  - `0` = leaf passes only (status quo)
  - `1` = leaf pass + one d0→d1 condensation pass if eligible
  - `2` = leaf pass + d0→d1 + d1→d2 if eligible
  - `N` = leaf pass + condensation up to depth N, one pass per level

**Behavior:** After the leaf pass in `compactLeaf`, if `incrementalMaxDepth > 0`, iterate through depths 0..N-1. At each depth, check if there are ≥ `condensedMinFanout` same-depth nodes (using the normal fanout, NOT the hard fanout). If eligible, run one condensed pass at that depth. Stop after one pass per depth level — don't loop.

This means each incremental compaction advances the state machine by at most one step per depth level. Over multiple turns, leaves naturally cascade upward.

### 2. Manual `/compact` uses normal fanout

Remove `hardTrigger` from the manual compaction path. Manual `/compact` should use `condensedMinFanout` (default 4), not `condensedMinFanoutHard` (default 2).

**`hardTrigger` should only apply** when the hard context threshold is breached — the actual emergency case. Not for manual compaction.

In `engine.ts`, change:

```typescript
// Before:
const useHardTriggerSweep =
  manualCompactionRequested || forceCompaction || params.compactionTarget === "threshold";

// After:
const useHardTriggerSweep = false; // Reserved for future hard-threshold emergency path
```

Manual `/compact` still calls `compactFullSweep` with `force: true` (so it runs even if below threshold), but with `hardTrigger: false` (so it uses normal fanout thresholds).

**Note:** `compactionTarget === "threshold"` is the soft trigger proactive path — it should also use normal fanout. Hard fanout should be reserved for a future explicit hard-threshold emergency path, if we ever need one.

## Implementation Details

### Config addition (`src/plugins/lcm/db/config.ts`):

```typescript
incrementalMaxDepth: parseInt(env.LCM_INCREMENTAL_MAX_DEPTH ?? "0", 10),
```

### Modify `compactLeaf` (`src/plugins/lcm/compaction.ts`):

After the existing leaf pass, add condensation passes gated by `incrementalMaxDepth`:

```typescript
// After leaf pass...
if (this.config.incrementalMaxDepth > 0 && leafResult.actionTaken) {
  for (let depth = 0; depth < this.config.incrementalMaxDepth; depth++) {
    const candidate = await this.selectShallowestCondensationCandidate({
      conversationId,
      hardTrigger: false, // always normal fanout for incremental
    });
    if (!candidate || candidate.targetDepth !== depth) {
      break; // no eligible chunk at this depth, stop
    }
    // Run one condensed pass
    await this.condensedPass(
      conversationId,
      candidate.chunk.items,
      candidate.targetDepth,
      summarize,
    );
  }
}
```

### Modify `compact` / full sweep path (`src/plugins/lcm/engine.ts`):

Remove `hardTrigger: true` from manual compaction. The full sweep still runs all phases (leaf loop + condensed loop), just with normal fanout thresholds.

### Tests

- Test incremental with `incrementalMaxDepth: 0` → no condensation (existing behavior)
- Test incremental with `incrementalMaxDepth: 1` → creates d1 when ≥ 4 d0 leaves
- Test incremental with `incrementalMaxDepth: 2` → cascades to d2
- Test manual `/compact` uses `condensedMinFanout` (4) not `condensedMinFanoutHard` (2)
- Test that hard fanout is no longer triggered by any current path

## Config Example

```json
{
  "lcm": {
    "incrementalMaxDepth": 1,
    "leafMinFanout": 8,
    "condensedMinFanout": 4,
    "condensedMinFanoutHard": 2
  }
}
```
