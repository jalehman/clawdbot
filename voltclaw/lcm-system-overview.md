# LCM System Overview

## What LCM Is Trying to Do

Lossless Context Management (LCM) exists to solve a practical constraint: model context windows are limited, but useful work often depends on large and growing histories.

LCM keeps the **active context small** while preserving the ability to **recover and inspect older context** when needed.

"Lossless" here means operationally recoverable through lineage and retrieval, not byte-for-byte prompt reconstruction.

## Core Idea

The system treats conversation memory as two layers:

1. **Canonical layer (full fidelity)**

- Every message, tool result, and file artifact is persisted.
- This is the source of truth.

2. **Working layer (budgeted view)**

- A compact context assembled for the next model call.
- Built from recent raw turns plus summary nodes.

As conversation size grows, LCM compresses the working layer by replacing old raw spans with summaries, while maintaining links back to canonical records.

## The Main Systems and Their Roles

### 1) Ingestion and Persistence

The ingestion path captures all interaction events and normalizes them into durable records.

Responsibilities:

- Persist chronological messages.
- Persist typed message parts (text, tool output, file references, workflow events).
- Maintain ordering and session associations.

Outcome:

- No history is lost at write time.

### 2) Context Assembly

Before each model call, the assembler constructs the prompt context under a token budget.

Responsibilities:

- Include required policy/system content.
- Include freshest raw conversation turns.
- Pull in compact historical summaries when needed.
- Produce a deterministic ordered context and token estimate.

Outcome:

- The model gets a coherent and bounded working set.

### 3) Compaction Engine

When context pressure crosses configured thresholds, compaction runs.

Responsibilities:

- Summarize older raw message windows into leaf summaries.
- Summarize groups of summaries into condensed summaries.
- Replace old active items with summary nodes.
- Preserve lineage links for future expansion.

Outcome:

- Active context shrinks while historical access remains intact.

### 4) Retrieval and Expansion

When the agent needs details from compacted history, retrieval tools rehydrate targeted portions.

Responsibilities:

- Describe an LCM item and its metadata/lineage.
- Search prior history quickly (regex/full-text).
- Expand summary nodes into child summaries or raw source messages.

Outcome:

- The system can zoom from compact index-like memory back to detail on demand.

Sub-agent strategy:

- The main agent stays compact and uses retrieval for routing (find the right IDs).
- Deep expansion is delegated to sub-agents that traverse summary trees.
- Sub-agents return focused findings instead of flooding top-level context with raw history.
- File IDs are handled via metadata/lookup paths, while summary IDs are handled via expansion.

### 5) Integrity and Maintenance

A background integrity process continuously checks structure quality.

Responsibilities:

- Verify lineage consistency.
- Detect broken references/orphaned nodes.
- Ensure context pointers remain valid.
- Surface repair plans when inconsistencies appear.

Outcome:

- Long-running sessions remain trustworthy and navigable.

## How They Work Together End-to-End

1. User and tool activity enters via ingestion.
2. Canonical data is persisted immediately.
3. Context assembler builds the next model prompt from recent turns + summaries.
4. If token pressure is high, compaction engine compresses older active segments.
5. Future prompts use the new compact context.
6. When old detail is needed, the main agent routes to target IDs, sub-agents expand by lineage, and distilled results return to the main agent.
7. Integrity worker validates the structure over time.

This loop repeats continuously as sessions grow.

## Why This Achieves the Goal

LCM succeeds because it separates concerns:

- **Preservation** is handled by canonical storage.
- **Efficiency** is handled by dynamic context assembly + compaction.
- **Recoverability** is handled by lineage-aware retrieval.

That combination gives the agent a practical form of "unbounded" working memory:

- Not by stuffing everything into the active prompt,
- But by keeping a compact index and reloading detail precisely when required.

## Mental Model

A useful mental model is:

- Raw history is a library archive.
- Summaries are catalog/index cards.
- Active context is the desk workspace.
- Retrieval tools are librarians fetching source material on demand.

The desk stays clean and fast, but the archive remains accessible.

## Operational Tradeoffs

### Benefits

- Lower token load for long sessions.
- Better stability in very large projects.
- Clear provenance from summaries back to source content.

### Costs

- More system complexity (compaction + lineage + integrity jobs).
- Summary quality directly affects recall quality.
- Expansion adds extra retrieval steps in some workflows.

## Design Principles to Preserve

1. Canonical data is append-first and non-destructive.
2. Compaction never breaks source traceability.
3. Active context is always budget-aware.
4. Expansion is targeted, bounded, and deterministic.
5. Integrity checks are continuous, not optional.

## Implementation Success Criteria

A healthy LCM system should demonstrate:

- Significant reduction in active prompt tokens over time.
- Reliable expansion from any summary node to source context.
- Consistent search/describe behavior across raw and summarized content.
- Zero lineage corruption under normal operation.

## Relationship to the Internal Spec

Use this document as the conceptual architecture.

Use `lcm-implementation-spec.md` as the execution spec:

- concrete interfaces,
- worker contracts,
- storage schema,
- operational invariants.
