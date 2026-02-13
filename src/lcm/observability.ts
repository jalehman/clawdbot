import type { SummaryKind } from "./types.js";

/**
 * Structured metric event names emitted by the LCM observability surface.
 */
export type LcmMetricEventName =
  | "context_tokens"
  | "compaction_run"
  | "summary_created"
  | "expand_latency"
  | "search_latency"
  | "integrity_failure";

/**
 * Structured log payload for one metric event.
 */
export type LcmMetricEvent = {
  event: LcmMetricEventName;
  at_ms: number;
  conversation_id?: string;
  session_id?: string;
  compaction_id?: string;
  summary_id?: string;
  trigger_reason?: string;
  token_before?: number;
  token_after?: number;
  [key: string]: unknown;
};

/**
 * Latency aggregate for one metric family.
 */
export type LcmLatencySnapshot = {
  count: number;
  total_ms: number;
  max_ms: number;
  last_ms: number;
};

/**
 * Snapshot of in-memory LCM counters and latency aggregates.
 */
export type LcmMetricsSnapshot = {
  context_tokens: {
    samples: number;
    total: number;
    max: number;
    latest: number;
  };
  compaction_runs: number;
  summaries_created: number;
  summaries_created_by_kind: Partial<Record<SummaryKind, number>>;
  expand_latency_ms: LcmLatencySnapshot;
  search_latency_ms: LcmLatencySnapshot;
  integrity_failures: number;
  recent_events: LcmMetricEvent[];
};

/**
 * Runtime logger/collector hooks for metric events.
 */
export type CreateLcmMetricsOptions = {
  onEvent?: (event: LcmMetricEvent) => void;
  historyLimit?: number;
};

/**
 * Event payload for context token samples.
 */
export type LcmContextTokensMetric = {
  conversationId: string;
  sessionId?: string;
  tokens: number;
};

/**
 * Event payload for one compaction run.
 */
export type LcmCompactionRunMetric = {
  conversationId: string;
  sessionId?: string;
  compactionId: string;
  triggerReason: string;
  tokenBefore: number;
  tokenAfter: number;
};

/**
 * Event payload for one summary creation.
 */
export type LcmSummaryCreatedMetric = {
  conversationId: string;
  sessionId?: string;
  compactionId?: string;
  summaryId: string;
  kind: SummaryKind;
};

/**
 * Event payload for one summary-expansion request.
 */
export type LcmExpandLatencyMetric = {
  conversationId?: string;
  sessionId?: string;
  latencyMs: number;
  depth?: number;
  truncated?: boolean;
  resultCount?: number;
};

/**
 * Event payload for one retrieval search request.
 */
export type LcmSearchLatencyMetric = {
  conversationId?: string;
  sessionId?: string;
  latencyMs: number;
  mode: string;
  scope: string;
  scannedCount: number;
  resultCount: number;
};

/**
 * Event payload for one integrity failure.
 */
export type LcmIntegrityFailureMetric = {
  conversationId?: string;
  sessionId?: string;
  code: string;
  severity: string;
  fixable: boolean;
};

/**
 * Recording interface consumed by LCM components.
 */
export type LcmMetrics = {
  recordContextTokens(input: LcmContextTokensMetric): void;
  recordCompactionRun(input: LcmCompactionRunMetric): void;
  recordSummaryCreated(input: LcmSummaryCreatedMetric): void;
  recordExpandLatency(input: LcmExpandLatencyMetric): void;
  recordSearchLatency(input: LcmSearchLatencyMetric): void;
  recordIntegrityFailure(input: LcmIntegrityFailureMetric): void;
  snapshot(): LcmMetricsSnapshot;
};

type MutableLcmMetricsState = {
  contextTokens: {
    samples: number;
    total: number;
    max: number;
    latest: number;
  };
  compactionRuns: number;
  summariesCreated: number;
  summariesByKind: Partial<Record<SummaryKind, number>>;
  expandLatency: LcmLatencySnapshot;
  searchLatency: LcmLatencySnapshot;
  integrityFailures: number;
  events: LcmMetricEvent[];
};

/**
 * Build an in-memory LCM metrics recorder with structured event hooks.
 */
export function createLcmMetrics(options: CreateLcmMetricsOptions = {}): LcmMetrics {
  const historyLimit = clampInt(options.historyLimit, 200, 0, 5_000);
  const state: MutableLcmMetricsState = {
    contextTokens: {
      samples: 0,
      total: 0,
      max: 0,
      latest: 0,
    },
    compactionRuns: 0,
    summariesCreated: 0,
    summariesByKind: {},
    expandLatency: {
      count: 0,
      total_ms: 0,
      max_ms: 0,
      last_ms: 0,
    },
    searchLatency: {
      count: 0,
      total_ms: 0,
      max_ms: 0,
      last_ms: 0,
    },
    integrityFailures: 0,
    events: [],
  };

  const emit = (
    event: { event: LcmMetricEventName } & Omit<LcmMetricEvent, "at_ms" | "event">,
  ): void => {
    const { event: eventName, ...rest } = event;
    const entry: LcmMetricEvent = {
      at_ms: Date.now(),
      event: eventName,
      ...rest,
    };
    if (historyLimit > 0) {
      state.events.push(entry);
      if (state.events.length > historyLimit) {
        state.events.splice(0, state.events.length - historyLimit);
      }
    }
    options.onEvent?.(entry);
  };

  return {
    recordContextTokens(input) {
      const tokens = Math.max(0, Math.trunc(input.tokens));
      state.contextTokens.samples += 1;
      state.contextTokens.total += tokens;
      state.contextTokens.latest = tokens;
      state.contextTokens.max = Math.max(state.contextTokens.max, tokens);
      emit({
        event: "context_tokens",
        conversation_id: input.conversationId,
        session_id: input.sessionId,
        token_after: tokens,
      });
    },
    recordCompactionRun(input) {
      state.compactionRuns += 1;
      emit({
        event: "compaction_run",
        conversation_id: input.conversationId,
        session_id: input.sessionId,
        compaction_id: input.compactionId,
        trigger_reason: input.triggerReason,
        token_before: Math.max(0, Math.trunc(input.tokenBefore)),
        token_after: Math.max(0, Math.trunc(input.tokenAfter)),
      });
    },
    recordSummaryCreated(input) {
      state.summariesCreated += 1;
      state.summariesByKind[input.kind] = (state.summariesByKind[input.kind] ?? 0) + 1;
      emit({
        event: "summary_created",
        conversation_id: input.conversationId,
        session_id: input.sessionId,
        compaction_id: input.compactionId,
        summary_id: input.summaryId,
        kind: input.kind,
      });
    },
    recordExpandLatency(input) {
      recordLatency(state.expandLatency, input.latencyMs);
      emit({
        event: "expand_latency",
        conversation_id: input.conversationId,
        session_id: input.sessionId,
        latency_ms: state.expandLatency.last_ms,
        depth: input.depth,
        truncated: input.truncated,
        result_count: input.resultCount,
      });
    },
    recordSearchLatency(input) {
      recordLatency(state.searchLatency, input.latencyMs);
      emit({
        event: "search_latency",
        conversation_id: input.conversationId,
        session_id: input.sessionId,
        latency_ms: state.searchLatency.last_ms,
        mode: input.mode,
        scope: input.scope,
        scanned_count: input.scannedCount,
        result_count: input.resultCount,
      });
    },
    recordIntegrityFailure(input) {
      state.integrityFailures += 1;
      emit({
        event: "integrity_failure",
        conversation_id: input.conversationId,
        session_id: input.sessionId,
        code: input.code,
        severity: input.severity,
        fixable: input.fixable,
      });
    },
    snapshot() {
      return {
        context_tokens: {
          ...state.contextTokens,
        },
        compaction_runs: state.compactionRuns,
        summaries_created: state.summariesCreated,
        summaries_created_by_kind: { ...state.summariesByKind },
        expand_latency_ms: { ...state.expandLatency },
        search_latency_ms: { ...state.searchLatency },
        integrity_failures: state.integrityFailures,
        recent_events: [...state.events],
      };
    },
  };
}

function recordLatency(state: LcmLatencySnapshot, latencyMs: number): void {
  const bounded = Math.max(0, Math.trunc(latencyMs));
  state.count += 1;
  state.total_ms += bounded;
  state.max_ms = Math.max(state.max_ms, bounded);
  state.last_ms = bounded;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
