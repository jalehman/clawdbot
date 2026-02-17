# LCM Depth-Aware Condensation

**Status:** Draft  
**Author:** Buce + Josh  
**Date:** 2026-02-17  
**Branch:** `josh/lcm`

## Problem

The current condensation algorithm produces **degenerate trees** — effectively linked lists.

Phase 2 of `compactFullSweep` grabs the oldest contiguous block of summaries (regardless of kind or depth) and condenses them. Over time, this creates a pattern where the single condensed node from the previous round gets combined with newly-created leaves:

```
Round 1: [leaf_A, leaf_B, leaf_C, leaf_D] → condensed_1
Round 2: [condensed_1, leaf_E, leaf_F, leaf_G] → condensed_2
Round 3: [condensed_2, leaf_H, leaf_I, leaf_J] → condensed_3
```

The resulting DAG:

```
condensed_3 (depth 3)
├── condensed_2 (depth 2)
│   ├── condensed_1 (depth 1)
│   │   ├── leaf_A
│   │   ├── leaf_B
│   │   ├── leaf_C
│   │   └── leaf_D
│   ├── leaf_E
│   ├── leaf_F
│   └── leaf_G
├── leaf_H
├── leaf_I
└── leaf_J
```

### Consequences

1. **Asymmetric information loss.** Leaf_A has been through 3 rounds of summarization. Leaf_J has been through 1. The oldest content decays exponentially faster than recent content.

2. **Abstraction-level mismatch.** When condensed_2 (~2k tokens representing ~15k of original content) gets summarized alongside fresh 1200-token leaves, the LLM must jointly compress content at fundamentally different compression ratios. The condensed node's framing dominates, and fresh leaf detail gets absorbed into the existing narrative.

3. **Unpredictable expand cost.** Recovering early conversation detail requires recursively expanding deep into the left spine (potentially 5–10+ levels). Recent content is one expand away. There's no way for the model to know about this asymmetry from the single top-level summary.

4. **Poor expansion signals.** A single mega-node covering the entire conversation gives the model an "expand everything or nothing" choice. Multiple summaries at similar depth would provide chapter-like landmarks for targeted recall.

## Design

### Core Principle

**Only condense nodes at the same depth.** Leaves (depth 0) condense with leaves → depth-1 node. Depth-1 nodes condense with depth-1 → depth-2. This produces a balanced tree where all original content sits at uniform depth and information loss is evenly distributed.

### Target Structure

With a minimum fanout of 4:

```
depth-2 node (1 node, covers 16 leaves)
├── depth-1_A (covers leaves 1–4)
├── depth-1_B (covers leaves 5–8)
├── depth-1_C (covers leaves 9–12)
└── depth-1_D (covers leaves 13–16)
    ├── leaf_13
    ├── leaf_14
    ├── leaf_15
    └── leaf_16
```

Capacity per depth level (fanout=4, ~1200 token leaves):

- Depth 0: 4 leaves
- Depth 1: 4 nodes × 4 leaves = 16 leaves
- Depth 2: 4 × 16 = 64 leaves
- Depth 3: 4 × 64 = 256 leaves

Expand cost is always `log₄(N)` — predictable and bounded.

### Steady-State Context

Instead of converging to a single mega-node, the context prefix would look like:

```
[depth-2_old, depth-1_A, depth-1_B, depth-1_C, depth-0_X, depth-0_Y, depth-0_Z, messages...]
  ^oldest                                                          ^newest          ^fresh tail
```

Multiple summary nodes at different depths provide temporal landmarks. The model can read them and reason about _which_ region to expand into.

## Schema Changes

### `summaries` table

Add `depth` column:

```sql
ALTER TABLE summaries ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
```

- Leaf summaries: `depth = 0`
- Condensed summaries: `depth = max(child_depths) + 1`

### Migration for existing data

For conversations with existing summaries:

1. All `kind = 'leaf'` → `depth = 0`
2. All `kind = 'condensed'` → compute from DAG:
   - Walk `summary_parents` to find max child depth
   - If all parents are leaves → depth 1
   - Otherwise → `max(parent.depth) + 1`
   - Fallback for parentless condensed: `depth = 1`

This is a small graph walk (typically < 50 nodes per conversation) and can run inline in the migration.

### `kind` field

Keep `kind` (`leaf` | `condensed`) for backwards compatibility. It becomes derivable from depth (`depth = 0` ↔ `leaf`, `depth > 0` ↔ `condensed`) but existing code references `kind` extensively. No change needed.

## Algorithm Changes

### Phase 1: Leaf Compaction (unchanged)

Raw message chunks → leaf summaries (depth 0). Both incremental (soft trigger) and full-sweep variants stay the same.

### Phase 2: Depth-Aware Condensation (replaces current Phase 2)

```
function condensedPhase(conversationId):
  while true:
    // Find the shallowest depth with enough nodes to condense
    candidate = null
    for d in getDistinctDepthsInContext(conversationId, ascending):
      nodesAtDepth = getContextSummariesAtDepth(conversationId, d)
      if len(nodesAtDepth) < minFanout:
        continue
      chunk = selectOldestChunkAtDepth(conversationId, d, chunkTokenBudget)
      if chunk.summaryTokens < minChunkTokens:
        continue
      candidate = (depth: d, chunk: chunk)
      break  // always process shallowest eligible depth first

    if candidate is null:
      break  // nothing more to condense at any depth

    newDepth = candidate.depth + 1
    condense(candidate.chunk) → summary with depth = newDepth

    if tokensAfter >= tokensBefore:
      break  // convergence check
```

Key behaviors:

- **Shallowest-first:** Always processes the lowest eligible depth before moving up. This ensures leaves get condensed into depth-1 nodes before depth-1 nodes get condensed into depth-2, maintaining proper tree structure.
- **Loop continues:** After condensing at depth D, the loop restarts from the shallowest depth. Newly created depth D+1 nodes won't be eligible until enough accumulate.
- **Same termination conditions:** Minimum fanout, minimum chunk tokens, token convergence.

### `selectOldestChunkAtDepth`

Replaces `selectOldestCondensedChunk`. Same logic but filtered to summaries at a specific depth:

```
function selectOldestChunkAtDepth(conversationId, targetDepth, tokenBudget):
  contextItems = getContextItems(conversationId)
  freshTailOrdinal = resolveFreshTailOrdinal(contextItems)

  chunk = []
  summaryTokens = 0
  for item in contextItems:
    if item.ordinal >= freshTailOrdinal:
      break
    if item.itemType != "summary" or item.summaryId == null:
      if chunk.length > 0:
        break  // contiguity break
      continue
    summary = getSummary(item.summaryId)
    if summary.depth != targetDepth:
      if chunk.length > 0:
        break  // depth break — don't mix depths
      continue
    if chunk.length > 0 and summaryTokens + summary.tokenCount > tokenBudget:
      break
    chunk.push(item)
    summaryTokens += summary.tokenCount
    if summaryTokens >= tokenBudget:
      break

  return { items: chunk, summaryTokens }
```

Critical difference from current: the loop **breaks on depth mismatch** when a chunk is already started. This prevents mixing depths within a single condensation pass.

### `getDistinctDepthsInContext`

New helper — queries context_items joined with summaries to find distinct depths present:

```sql
SELECT DISTINCT s.depth
FROM context_items ci
JOIN summaries s ON s.summary_id = ci.summary_id
WHERE ci.conversation_id = ?
  AND ci.item_type = 'summary'
ORDER BY s.depth ASC
```

### Context Ordering Invariant

With depth-aware condensation, context items maintain a natural ordering:

```
[highest-depth (oldest) ... lower-depth ... depth-0 (recent leaves) ... raw messages ... fresh tail]
```

This holds because:

- Older content gets promoted to higher depths first
- New leaves always appear after existing summaries
- Condensation replaces the ordinal range of its sources

No explicit reordering needed — the ordinal-based insertion naturally preserves this.

## Configuration

### New parameters

| Parameter                | Default | Description                                                          |
| ------------------------ | ------- | -------------------------------------------------------------------- |
| `condensedMinFanout`     | `4`     | Minimum same-depth nodes required to trigger condensation            |
| `condensedMinFanoutHard` | `2`     | Lower minimum for hard triggers / force compaction (more aggressive) |

### Existing parameters (no change)

| Parameter               | Current Default | Notes                                         |
| ----------------------- | --------------- | --------------------------------------------- |
| `leafChunkTokens`       | `20000`         | Reused as chunk token budget for condensation |
| `condensedTargetTokens` | configurable    | Target output size for condensed summaries    |
| `contextThreshold`      | `0.75`          | Ratio triggering full sweep                   |
| `freshTailCount`        | `32`            | Protected recent messages                     |

### Fanout guidance

- **Too low (2):** Binary tree — many levels, each condensation does minimal compression, deeper DAG
- **Too high (8):** Leaves accumulate for a long time before condensation fires, higher context usage
- **Sweet spot (3–4):** Balanced tree with reasonable depth, good compression per pass, manageable context

## Interaction with Existing Triggers

### Incremental leaf compaction (soft trigger)

**No change.** Soft triggers only create depth-0 leaves. They don't trigger condensation.

### Full sweep (hard trigger / `/compact`)

Phase 2 changes to depth-aware algorithm above. Phase 1 (leaf passes) unchanged.

### Force compaction

Uses `condensedMinFanoutHard` (default 2) instead of `condensedMinFanout` (default 4), allowing more aggressive condensation when explicitly requested or when context pressure is critical.

## Impact on `lcm_expand`

Depth-aware condensation significantly improves expand utility:

1. **Predictable cost:** Expanding a node always reveals ~fanout children, all at uniform depth. No more recursive deep-left-spine traversal.

2. **Better expansion signals:** Multiple summary nodes in context (at different depths) act as chapter headings. The model can read "depth-2 covers threads 1–64, depth-1_C covers threads 49–64" and expand specifically where needed.

3. **Uniform detail recovery:** All original content is the same number of expand hops away. No asymmetry between old and new content.

4. **DAG traversal unchanged:** `lcm_expand` already walks `summary_parents`. The DAG structure changes but the traversal code doesn't need modification.

## Testing Strategy

### Unit tests

1. **Depth assignment:** Verify leaves get depth 0, condensed nodes get `max(child_depths) + 1`
2. **Same-depth selection:** `selectOldestChunkAtDepth` only returns summaries at the requested depth
3. **Depth break:** Chunk building stops when encountering a different-depth summary
4. **Shallowest-first:** Phase 2 processes depth 0 before depth 1
5. **Fanout threshold:** Condensation doesn't fire with fewer than `minFanout` nodes at a depth

### Integration tests

1. **Balanced tree construction:** Run multiple rounds of compaction, verify the resulting DAG is balanced (all leaves at same depth from root)
2. **Migration:** Create summaries under old schema, run migration, verify depth assignment
3. **Mixed workload:** Interleave leaf creation and full sweeps, verify tree stays balanced
4. **Expand after depth-aware compaction:** Verify `lcm_expand` correctly traverses the balanced tree

### Regression

1. **Soft trigger unchanged:** Verify incremental leaf compaction still works identically
2. **Token reduction:** Full sweep still reduces context tokens below threshold
3. **Fresh tail protection:** Raw messages in the fresh tail are never touched

## Migration Path

1. Add `depth` column to summaries table (DEFAULT 0)
2. Run backfill: compute depth for existing condensed summaries from DAG
3. Deploy new `selectOldestChunkAtDepth` + depth-aware Phase 2
4. Old summaries with computed depths work correctly — no recompaction needed

The migration is backwards-compatible. If depth is missing (shouldn't happen with DEFAULT 0), the code treats it as 0.

## Open Questions

1. **Should incremental condensation also be depth-aware?** Currently only leaf compaction runs incrementally. We could add an incremental depth-0 condensation trigger (fire when ≥ minFanout leaves accumulate). Deferred to v2.

2. **Variable chunk budget by depth?** Higher-depth nodes are denser. Should the chunk token budget scale with depth? Probably not for v1 — the fixed budget naturally reduces fanout at higher depths (each node is larger), which is acceptable.

3. **lcm-tui updates?** The TUI should display depth in the summary DAG view. Minor enhancement, separate issue.
