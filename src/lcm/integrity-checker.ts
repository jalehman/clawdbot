import type { LcmMetrics } from "./observability.js";
import type { LcmSqlValue } from "./storage/types.js";
import type { LcmStorageBackend, LcmStorageConnection } from "./storage/types.js";
import type {
  ConversationId,
  IntegrityChecker,
  IntegritySeverity,
  LcmIntegrityIssue,
} from "./types.js";

/**
 * Execution mode for one integrity pass.
 */
export type LcmIntegrityCheckMode = "check" | "repair";

/**
 * Enumerated violation identifiers emitted by the integrity scanner.
 */
export type LcmIntegrityViolationCode =
  | "summary_without_source"
  | "context_item_missing_conversation"
  | "context_item_missing_source_message"
  | "lineage_edge_missing_context_item"
  | "duplicate_message_ordinal"
  | "duplicate_message_part_ordinal"
  | "message_context_missing_canonical_message"
  | "orphan_message_part";

/**
 * One integrity violation discovered by a scan.
 */
export type LcmIntegrityViolation = {
  code: LcmIntegrityViolationCode;
  invariant: 1 | 2 | 3 | 4;
  severity: IntegritySeverity;
  message: string;
  fixable: boolean;
  conversationId?: ConversationId;
  entityId?: string;
  details?: Record<string, unknown>;
  repairActionIds: string[];
};

/**
 * Supported SQL-backed repair operations.
 */
export type LcmIntegrityRepairActionKind =
  | "delete_context_item"
  | "clear_context_source_message"
  | "delete_lineage_edge";

/**
 * SQL repair step generated from a fixable violation.
 */
export type LcmIntegrityRepairAction = {
  actionId: string;
  kind: LcmIntegrityRepairActionKind;
  description: string;
  sql: string;
  params: ReadonlyArray<LcmSqlValue>;
};

/**
 * Ordered plan of SQL actions that can repair fixable violations.
 */
export type LcmIntegrityRepairPlan = {
  generatedAt: string;
  actions: LcmIntegrityRepairAction[];
};

/**
 * Repair execution summary for repair mode scans.
 */
export type LcmIntegrityRepairResult = {
  attempted: number;
  applied: number;
};

/**
 * Per-invariant status for one scan.
 */
export type LcmIntegrityInvariantStatus = {
  id: 1 | 2 | 3 | 4;
  ok: boolean;
  violationCount: number;
};

/**
 * Structured output from the integrity scanner.
 */
export type LcmIntegrityReport = {
  mode: LcmIntegrityCheckMode;
  scannedAt: string;
  conversationId?: ConversationId;
  ok: boolean;
  invariants: LcmIntegrityInvariantStatus[];
  violations: LcmIntegrityViolation[];
  preRepairViolationCount?: number;
  repairPlan: LcmIntegrityRepairPlan;
  repairResult?: LcmIntegrityRepairResult;
};

type CreateLcmIntegrityCheckerParams = {
  backend: LcmStorageBackend;
  metrics?: LcmMetrics;
};

type IntegrityCollectResult = {
  violations: LcmIntegrityViolation[];
  repairActions: LcmIntegrityRepairAction[];
};

type OrphanContextRow = {
  item_id: string;
  conversation_id: string;
};

type MissingSourceMessageRow = {
  item_id: string;
  conversation_id: string;
  item_type: string;
  source_message_id: string;
};

type MissingLineageItemRow = {
  parent_item_id: string;
  child_item_id: string;
  relation: string;
};

type DuplicateMessageOrdinalRow = {
  conversation_id: string;
  ordinal: number;
  row_count: number;
  message_ids: string;
};

type DuplicatePartOrdinalRow = {
  message_id: string;
  part_index: number;
  row_count: number;
  part_ids: string;
};

type OrphanMessagePartRow = {
  part_id: string;
  message_id: string;
};

type SummaryWithoutSourceRow = {
  item_id: string;
  conversation_id: string;
};

/**
 * Construct a SQLite integrity checker for LCM storage invariants.
 */
export function createLcmIntegrityChecker(
  params: CreateLcmIntegrityCheckerParams,
): IntegrityChecker {
  return new SqliteLcmIntegrityChecker(params);
}

/**
 * SQLite implementation for scanning and optionally repairing integrity issues.
 */
export class SqliteLcmIntegrityChecker implements IntegrityChecker {
  private readonly backend: LcmStorageBackend;
  private readonly metrics: LcmMetrics | null;

  /**
   * Build a checker around one migrated LCM backend.
   */
  constructor(params: CreateLcmIntegrityCheckerParams) {
    this.backend = params.backend;
    this.metrics = params.metrics ?? null;
  }

  /**
   * Backward-compatible issue check for one conversation id.
   */
  async checkConversation(conversationId: ConversationId): Promise<LcmIntegrityIssue[]> {
    const report = await this.scan({ conversationId, mode: "check" });
    return report.violations.map((violation) => ({
      severity: violation.severity,
      code: violation.code,
      message: violation.message,
      conversationId: violation.conversationId ?? conversationId,
      relatedSummaryId:
        violation.code === "summary_without_source" ? asSummaryId(violation) : undefined,
      relatedMessageId:
        violation.code === "context_item_missing_source_message" ||
        violation.code === "message_context_missing_canonical_message"
          ? asMessageId(violation)
          : undefined,
    }));
  }

  /**
   * Scan for integrity violations and optionally apply generated repairs.
   */
  async scan(
    input: {
      mode?: LcmIntegrityCheckMode;
      conversationId?: ConversationId;
    } = {},
  ): Promise<LcmIntegrityReport> {
    const mode = input.mode ?? "check";
    const firstPass = this.collectViolations(input.conversationId);
    for (const violation of firstPass.violations) {
      this.metrics?.recordIntegrityFailure({
        conversationId: violation.conversationId,
        code: violation.code,
        severity: violation.severity,
        fixable: violation.fixable,
      });
    }

    const repairPlan: LcmIntegrityRepairPlan = {
      generatedAt: new Date().toISOString(),
      actions: firstPass.repairActions,
    };

    if (mode === "check") {
      return this.buildReport({
        mode,
        conversationId: input.conversationId,
        violations: firstPass.violations,
        repairPlan,
      });
    }

    const repairResult = await this.applyRepairPlan(repairPlan);
    const secondPass = this.collectViolations(input.conversationId);
    return this.buildReport({
      mode,
      conversationId: input.conversationId,
      violations: secondPass.violations,
      preRepairViolationCount: firstPass.violations.length,
      repairPlan,
      repairResult,
    });
  }

  private buildReport(params: {
    mode: LcmIntegrityCheckMode;
    conversationId?: ConversationId;
    violations: LcmIntegrityViolation[];
    repairPlan: LcmIntegrityRepairPlan;
    preRepairViolationCount?: number;
    repairResult?: LcmIntegrityRepairResult;
  }): LcmIntegrityReport {
    const invariantCounts = new Map<1 | 2 | 3 | 4, number>([
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
    ]);
    for (const violation of params.violations) {
      invariantCounts.set(violation.invariant, (invariantCounts.get(violation.invariant) ?? 0) + 1);
    }

    const invariants: LcmIntegrityInvariantStatus[] = [1, 2, 3, 4].map((id) => {
      const violationCount = invariantCounts.get(id as 1 | 2 | 3 | 4) ?? 0;
      return {
        id: id as 1 | 2 | 3 | 4,
        ok: violationCount === 0,
        violationCount,
      };
    });

    return {
      mode: params.mode,
      scannedAt: new Date().toISOString(),
      conversationId: params.conversationId,
      ok: params.violations.length === 0,
      invariants,
      violations: params.violations,
      preRepairViolationCount: params.preRepairViolationCount,
      repairPlan: params.repairPlan,
      repairResult: params.repairResult,
    };
  }

  private collectViolations(conversationId?: ConversationId): IntegrityCollectResult {
    const violations: LcmIntegrityViolation[] = [];
    const actionBySignature = new Map<string, LcmIntegrityRepairAction>();

    const createRepairAction = (action: Omit<LcmIntegrityRepairAction, "actionId">): string => {
      const signature = `${action.kind}:${action.sql}:${JSON.stringify(action.params)}`;
      const existing = actionBySignature.get(signature);
      if (existing) {
        return existing.actionId;
      }
      const actionId = `repair_${actionBySignature.size + 1}`;
      actionBySignature.set(signature, { ...action, actionId });
      return actionId;
    };

    const pushViolation = (violation: Omit<LcmIntegrityViolation, "repairActionIds">): void => {
      violations.push({ ...violation, repairActionIds: [] });
    };

    const linkRepair = (
      violation: Omit<LcmIntegrityViolation, "repairActionIds">,
      action: Omit<LcmIntegrityRepairAction, "actionId">,
    ): void => {
      const actionId = createRepairAction(action);
      violations.push({ ...violation, repairActionIds: [actionId] });
    };

    // Invariant 1: every summary must point to at least one parent source.
    const summaryWithoutSourceRows = this.backend.all<SummaryWithoutSourceRow>(
      `SELECT s.item_id, s.conversation_id
       FROM lcm_context_items s
       LEFT JOIN lcm_lineage_edges edge ON edge.child_item_id = s.item_id
       WHERE s.item_type = 'summary'
         ${conversationId ? "AND s.conversation_id = ?" : ""}
       GROUP BY s.item_id, s.conversation_id
       HAVING COUNT(edge.parent_item_id) = 0`,
      conversationId ? [conversationId] : [],
    );
    for (const row of summaryWithoutSourceRows) {
      pushViolation({
        code: "summary_without_source",
        invariant: 1,
        severity: "error",
        fixable: false,
        conversationId: row.conversation_id as ConversationId,
        entityId: row.item_id,
        message: `Summary '${row.item_id}' has no source linkage.`,
      });
    }

    // Invariant 2: all context references must point to existing rows.
    const orphanContextRows = this.backend.all<OrphanContextRow>(
      `SELECT ci.item_id, ci.conversation_id
       FROM lcm_context_items ci
       LEFT JOIN lcm_conversations convo ON convo.conversation_id = ci.conversation_id
       WHERE convo.conversation_id IS NULL
         ${conversationId ? "AND ci.conversation_id = ?" : ""}`,
      conversationId ? [conversationId] : [],
    );
    for (const row of orphanContextRows) {
      linkRepair(
        {
          code: "context_item_missing_conversation",
          invariant: 2,
          severity: "error",
          fixable: true,
          conversationId: row.conversation_id as ConversationId,
          entityId: row.item_id,
          message: `Context item '${row.item_id}' references a missing conversation '${row.conversation_id}'.`,
        },
        {
          kind: "delete_context_item",
          description: `Delete orphan context item '${row.item_id}'.`,
          sql: "DELETE FROM lcm_context_items WHERE item_id = ?",
          params: [row.item_id],
        },
      );
    }

    const missingSourceRows = this.backend.all<MissingSourceMessageRow>(
      `SELECT ci.item_id, ci.conversation_id, ci.item_type, ci.source_message_id
       FROM lcm_context_items ci
       LEFT JOIN lcm_messages msg ON msg.message_id = ci.source_message_id
       WHERE ci.source_message_id IS NOT NULL
         AND msg.message_id IS NULL
         ${conversationId ? "AND ci.conversation_id = ?" : ""}`,
      conversationId ? [conversationId] : [],
    );
    for (const row of missingSourceRows) {
      if (row.item_type === "message") {
        pushViolation({
          code: "context_item_missing_source_message",
          invariant: 2,
          severity: "error",
          fixable: false,
          conversationId: row.conversation_id as ConversationId,
          entityId: row.item_id,
          message: `Message context item '${row.item_id}' points to missing message '${row.source_message_id}'.`,
          details: { source_message_id: row.source_message_id },
        });
        pushViolation({
          code: "message_context_missing_canonical_message",
          invariant: 4,
          severity: "error",
          fixable: false,
          conversationId: row.conversation_id as ConversationId,
          entityId: row.item_id,
          message: `Canonical message '${row.source_message_id}' is missing for message context item '${row.item_id}'.`,
          details: { source_message_id: row.source_message_id },
        });
        continue;
      }

      linkRepair(
        {
          code: "context_item_missing_source_message",
          invariant: 2,
          severity: "error",
          fixable: true,
          conversationId: row.conversation_id as ConversationId,
          entityId: row.item_id,
          message: `Context item '${row.item_id}' points to missing source message '${row.source_message_id}'.`,
          details: { source_message_id: row.source_message_id },
        },
        {
          kind: "clear_context_source_message",
          description: `Clear missing source message reference on context item '${row.item_id}'.`,
          sql: "UPDATE lcm_context_items SET source_message_id = NULL, updated_at_ms = ? WHERE item_id = ?",
          params: [Date.now(), row.item_id],
        },
      );
    }

    const danglingLineageRows = this.backend.all<MissingLineageItemRow>(
      `SELECT edge.parent_item_id, edge.child_item_id, edge.relation
       FROM lcm_lineage_edges edge
       LEFT JOIN lcm_context_items parent ON parent.item_id = edge.parent_item_id
       LEFT JOIN lcm_context_items child ON child.item_id = edge.child_item_id
       WHERE (parent.item_id IS NULL OR child.item_id IS NULL)
         ${conversationId ? "AND (parent.conversation_id = ? OR child.conversation_id = ?)" : ""}`,
      conversationId ? [conversationId, conversationId] : [],
    );
    for (const row of danglingLineageRows) {
      const edgeId = `${row.parent_item_id}->${row.child_item_id}:${row.relation}`;
      linkRepair(
        {
          code: "lineage_edge_missing_context_item",
          invariant: 2,
          severity: "error",
          fixable: true,
          entityId: edgeId,
          message: `Lineage edge '${edgeId}' points to missing context items.`,
        },
        {
          kind: "delete_lineage_edge",
          description: `Delete dangling lineage edge '${edgeId}'.`,
          sql: "DELETE FROM lcm_lineage_edges WHERE parent_item_id = ? AND child_item_id = ? AND relation = ?",
          params: [row.parent_item_id, row.child_item_id, row.relation],
        },
      );
    }

    // Invariant 3: no duplicate ordinals for messages or message parts.
    const duplicateMessageRows = this.backend.all<DuplicateMessageOrdinalRow>(
      `SELECT conversation_id, ordinal, COUNT(*) AS row_count, GROUP_CONCAT(message_id) AS message_ids
       FROM lcm_messages
       ${conversationId ? "WHERE conversation_id = ?" : ""}
       GROUP BY conversation_id, ordinal
       HAVING COUNT(*) > 1`,
      conversationId ? [conversationId] : [],
    );
    for (const row of duplicateMessageRows) {
      pushViolation({
        code: "duplicate_message_ordinal",
        invariant: 3,
        severity: "error",
        fixable: false,
        conversationId: row.conversation_id as ConversationId,
        entityId: `${row.conversation_id}:${row.ordinal}`,
        message: `Duplicate message ordinal ${row.ordinal} in conversation '${row.conversation_id}'.`,
        details: {
          row_count: row.row_count,
          message_ids: splitCsv(row.message_ids),
        },
      });
    }

    const duplicatePartRows = this.backend.all<DuplicatePartOrdinalRow>(
      `SELECT part.message_id, part.part_index, COUNT(*) AS row_count, GROUP_CONCAT(part.part_id) AS part_ids
       FROM lcm_message_parts part
       ${
         conversationId
           ? "INNER JOIN lcm_messages msg ON msg.message_id = part.message_id AND msg.conversation_id = ?"
           : ""
       }
       GROUP BY part.message_id, part.part_index
       HAVING COUNT(*) > 1`,
      conversationId ? [conversationId] : [],
    );
    for (const row of duplicatePartRows) {
      pushViolation({
        code: "duplicate_message_part_ordinal",
        invariant: 3,
        severity: "error",
        fixable: false,
        entityId: `${row.message_id}:${row.part_index}`,
        message: `Duplicate part ordinal ${row.part_index} for message '${row.message_id}'.`,
        details: {
          row_count: row.row_count,
          part_ids: splitCsv(row.part_ids),
        },
      });
    }

    // Invariant 4: canonical raw message/part rows must never be deleted.
    const orphanPartRows = this.backend.all<OrphanMessagePartRow>(
      `SELECT part.part_id, part.message_id
       FROM lcm_message_parts part
       LEFT JOIN lcm_messages msg ON msg.message_id = part.message_id
       WHERE msg.message_id IS NULL`,
      [],
    );
    for (const row of orphanPartRows) {
      pushViolation({
        code: "orphan_message_part",
        invariant: 4,
        severity: "error",
        fixable: false,
        entityId: row.part_id,
        message: `Message part '${row.part_id}' points to missing canonical message '${row.message_id}'.`,
        details: {
          message_id: row.message_id,
        },
      });
    }

    return {
      violations,
      repairActions: Array.from(actionBySignature.values()),
    };
  }

  private async applyRepairPlan(plan: LcmIntegrityRepairPlan): Promise<LcmIntegrityRepairResult> {
    if (plan.actions.length === 0) {
      return { attempted: 0, applied: 0 };
    }

    let applied = 0;
    await this.backend.withTransaction(async (tx) => {
      for (const action of plan.actions) {
        applyRepairAction(tx, action);
        applied += 1;
      }
    });
    return {
      attempted: plan.actions.length,
      applied,
    };
  }
}

function applyRepairAction(tx: LcmStorageConnection, action: LcmIntegrityRepairAction): void {
  tx.execute(action.sql, action.params);
}

function splitCsv(value: string): string[] {
  if (!value.trim()) {
    return [];
  }
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function asSummaryId(violation: LcmIntegrityViolation): LcmIntegrityIssue["relatedSummaryId"] {
  return violation.entityId
    ? (violation.entityId as LcmIntegrityIssue["relatedSummaryId"])
    : undefined;
}

function asMessageId(violation: LcmIntegrityViolation): LcmIntegrityIssue["relatedMessageId"] {
  const source = violation.details?.source_message_id;
  if (typeof source === "string" && source.trim()) {
    return source as LcmIntegrityIssue["relatedMessageId"];
  }
  return undefined;
}
