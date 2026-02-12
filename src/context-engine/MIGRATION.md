# Context Engine Migration Notes

This folder defines the pluggable context lifecycle used by embedded runner and `/compact` flows.
Use this guide when adding a new engine implementation.

## 1. Implement the `ContextEngine` contract

Create an engine that implements all three async phases in `src/context-engine/types.ts`:

- `ingest`: normalize transcript history.
- `assemble`: apply truncation/repair and build final prompt history.
- `compact`: perform lossy reduction and return `ContextCompactResult`.

Recommendation: start by copying `LegacyContextEngine` behavior in `src/context-engine/legacy-engine.ts`, then replace internals incrementally.

## 2. Register the engine

Register your factory with a unique id:

```ts
registerContextEngine("my-engine", () => new MyContextEngine());
```

Supported registration paths:

- Core registration code via `src/context-engine/registry.ts`.
- Plugin registration via `api.registerContextEngine(...)` in plugin `register()`.

## 3. Configure engine selection

Set config:

```yaml
contextEngine:
  engine: my-engine
```

Selection entrypoints:

- `selectContextEngine(...)` for low-level registry resolution.
- `resolveRuntimeContextEngine(...)` for runner/command callsites.

## Fallback and error behavior

Engine resolution is defensive:

- Unknown engine id: falls back to `legacy` and emits a warning.
- Engine factory throws: falls back to `legacy` and emits a warning.
- Legacy engine missing or broken: selection returns an error.

Runtime behavior (`run.ts`, `compact.ts`, `/compact` command):

- If resolution returns a usable engine, pluggable path is used.
- If no engine is available but legacy inline logic can run, runtime logs a warning and uses inline fallback behavior.

Plugin startup validation (`src/plugins/loader.ts`):

- When configured engine is missing or broken, diagnostics include fallback warnings.

## Safety checklist before merging

- Add/keep regression tests for selection (`default`, `invalid`, `factory throw`).
- Add parity checks against legacy behavior for assemble/compact outputs.
- Run test suite (`pnpm test:fast` or `pnpm test`).
