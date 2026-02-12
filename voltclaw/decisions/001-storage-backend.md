# Decision 001: LCM Storage Backend

- Status: accepted
- Date: 2026-02-12
- Epic: `openclaw-79e`
- Task: `openclaw-79e.1`

## Context

LCM needs durable local storage for canonical messages, context-item lineage, compaction runs, and retrieval search.
The draft schema described PostgreSQL semantics, but OpenClaw deployment frequently runs as a single local process where operational simplicity is critical.

This decision evaluates:

1. lineage-write transaction semantics
2. lock contention and retry behavior
3. full-text indexing/search feasibility
4. operational complexity in typical OpenClaw installs

## Options Considered

### Option A: SQLite (embedded, in-process)

Pros:

- Zero extra service dependency; single-file DB fits current OpenClaw local runtime.
- Supports ACID transactions, foreign keys, and `BEGIN IMMEDIATE` write coordination.
- WAL mode provides concurrent readers with a single writer, which matches LCM v1 workload.
- FTS5 gives built-in text indexing for `describe`/`grep` retrieval paths.
- Lowest operator burden for contributors, CI, and desktop/server installs.

Cons:

- Single-writer model can bottleneck under very high concurrent write load.
- No native row-level locking; contention must be handled via busy timeout + retries.
- Horizontal scale and remote/shared database deployments are weaker than Postgres.

### Option B: Embedded/Postgres service

Pros:

- Strong concurrency model for many concurrent writers.
- Mature lock handling and observability for multi-node services.
- Natural path if LCM becomes a shared central service.

Cons:

- Requires shipping/operating a database service for all installs.
- Higher setup, auth, upgrade, and backup complexity for local-first users.
- Adds deployment friction for plugin-centric OpenClaw usage.

## Decision

Use **SQLite as the LCM v1 backend**.

Rationale: v1 prioritizes low-friction deployment and local reliability over distributed-write scale.
SQLite in WAL mode satisfies required transactional integrity for lineage writes, provides acceptable contention behavior with busy-timeout/retry, and supports full-text retrieval with FTS5.

## Consequences

### Positive

- LCM can run in-process with no extra infrastructure.
- Deterministic local behavior for tests and development.
- Easier adoption in plugin-driven and desktop-focused environments.

### Negative / Risks

- Write-heavy concurrency may hit `SQLITE_BUSY` contention.
- FTS5 availability depends on SQLite build features.

### Mitigations Implemented

- Enable `PRAGMA journal_mode=WAL`.
- Enable `PRAGMA busy_timeout` and transaction retry loop for `SQLITE_BUSY`/`SQLITE_LOCKED`.
- Use foreign keys + transactional writes for lineage integrity.
- FTS schema creation is optional; backend remains usable when FTS5 is unavailable.

## Revisit Criteria

Re-open this decision if any of the following become true:

- sustained multi-writer contention causes frequent retries/timeouts,
- LCM storage must be shared across processes/hosts,
- operational needs require centralized backup/replication beyond file-level workflows.

At that point, introduce a Postgres backend behind the same storage interface and keep SQLite as default local backend.
