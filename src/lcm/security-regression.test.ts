import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationId, SummaryId } from "./types.js";
import { ExpansionGrantRegistry } from "./expansion-auth.js";
import { createLcmRetrievalEngine } from "./retrieval-engine.js";
import { createSqliteLcmStorageBackend } from "./storage/sqlite.js";
import { SubagentExpansionOrchestrator } from "./subagent-expansion.js";
import { createPlaceholderTokenEstimator } from "./token-estimator.js";

const OPEN_BACKENDS = new Set<ReturnType<typeof createSqliteLcmStorageBackend>>();
const OPEN_DIRS = new Set<string>();

afterEach(async () => {
  for (const backend of OPEN_BACKENDS) {
    await backend.close();
  }
  OPEN_BACKENDS.clear();

  for (const dir of OPEN_DIRS) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  OPEN_DIRS.clear();
});

describe("LCM security regression", () => {
  it("permits valid cross-session expansion and rejects expired or out-of-scope grants", async () => {
    const { expansionAuth, retrieval } = await createHarness();
    const now = 1_850_000_000_000;

    expansionAuth.issueGrant({
      delegatorSessionKey: "agent:main:root",
      delegateSessionKey: "agent:main:subagent:valid",
      conversationIds: ["conv-alpha"],
      maxDepth: 3,
      maxTokenCap: 5_000,
      ttlMs: 60_000,
      nowMs: now,
    });

    const allowed = await retrieval.expand({
      summaryId: "sum-alpha-root" as SummaryId,
      depth: 2,
      includeMessages: true,
      tokenCap: 2_000,
      auth: {
        sessionKey: "agent:main:subagent:valid",
        nowMs: now + 1,
      },
    });
    expect(allowed.conversationId).toBe("conv-alpha");
    expect(allowed.summaries.map((summary) => summary.id)).toContain("sum-alpha-child");

    expansionAuth.issueGrant({
      delegatorSessionKey: "agent:main:root",
      delegateSessionKey: "agent:main:subagent:expired",
      conversationIds: ["conv-alpha"],
      maxDepth: 3,
      maxTokenCap: 5_000,
      ttlMs: 1_000,
      nowMs: now,
    });

    await expect(
      retrieval.expand({
        summaryId: "sum-alpha-root" as SummaryId,
        depth: 1,
        tokenCap: 1_000,
        auth: {
          sessionKey: "agent:main:subagent:expired",
          nowMs: now + 5_000,
        },
      }),
    ).rejects.toThrow(/expired/i);

    await expect(
      retrieval.expand({
        summaryId: "sum-beta-root" as SummaryId,
        depth: 1,
        tokenCap: 1_000,
        auth: {
          sessionKey: "agent:main:subagent:valid",
          nowMs: now + 2,
        },
      }),
    ).rejects.toThrow(/outside delegated expansion scope/i);
  });

  it("enforces delegated depth and token caps", async () => {
    const { expansionAuth, retrieval } = await createHarness();
    const now = 1_850_000_010_000;

    expansionAuth.issueGrant({
      delegatorSessionKey: "agent:main:root",
      delegateSessionKey: "agent:main:subagent:bounded",
      conversationIds: ["conv-alpha"],
      maxDepth: 1,
      maxTokenCap: 300,
      ttlMs: 60_000,
      nowMs: now,
    });

    await expect(
      retrieval.expand({
        summaryId: "sum-alpha-root" as SummaryId,
        depth: 2,
        tokenCap: 200,
        auth: {
          sessionKey: "agent:main:subagent:bounded",
          nowMs: now + 1,
        },
      }),
    ).rejects.toThrow(/exceeds delegated maxDepth/i);

    await expect(
      retrieval.expand({
        summaryId: "sum-alpha-root" as SummaryId,
        depth: 1,
        tokenCap: 800,
        auth: {
          sessionKey: "agent:main:subagent:bounded",
          nowMs: now + 1,
        },
      }),
    ).rejects.toThrow(/exceeds delegated maxTokenCap/i);
  });

  it("forces retrieval auth checks before describe/grep/expand return results", async () => {
    const { expansionAuth, retrieval } = await createHarness();
    const now = 1_850_000_020_000;

    expansionAuth.issueGrant({
      delegatorSessionKey: "agent:main:root",
      delegateSessionKey: "agent:main:subagent:read",
      conversationIds: ["conv-alpha"],
      maxDepth: 3,
      maxTokenCap: 4_000,
      ttlMs: 60_000,
      nowMs: now,
    });

    const described = await retrieval.describe("sum-alpha-root", {
      sessionKey: "agent:main:subagent:read",
      nowMs: now + 1,
    });
    expect(described?.kind).toBe("summary");

    await expect(
      retrieval.describe("sum-beta-root", {
        sessionKey: "agent:main:subagent:read",
        nowMs: now + 1,
      }),
    ).rejects.toThrow(/outside delegated expansion scope/i);

    const scopedSearch = await retrieval.grep({
      query: "alpha-security-anchor",
      mode: "full_text",
      scope: "messages",
      conversationId: "conv-alpha" as ConversationId,
      auth: {
        sessionKey: "agent:main:subagent:read",
        nowMs: now + 1,
      },
    });
    expect(scopedSearch.matches.length).toBeGreaterThan(0);

    await expect(
      retrieval.grep({
        query: "anchor",
        mode: "regex",
        scope: "messages",
        auth: {
          sessionKey: "agent:main:subagent:read",
          nowMs: now + 1,
        },
      }),
    ).rejects.toThrow(/requires a scoped conversationId/i);
  });

  it("keeps subagent expansion within delegated authorization scope", async () => {
    const { expansionAuth, retrieval } = await createHarness();
    const now = 1_850_000_030_000;

    expansionAuth.issueGrant({
      delegatorSessionKey: "agent:main:root",
      delegateSessionKey: "agent:main:subagent:runner",
      conversationIds: ["conv-alpha"],
      maxDepth: 6,
      maxTokenCap: 8_000,
      ttlMs: 60_000,
      nowMs: now,
    });

    const runSubagent = vi.fn().mockResolvedValue(
      JSON.stringify({
        synthesis: "Checked delegated scope.",
        citedIds: ["sum-alpha-child"],
        nextSummaryIds: ["sum-beta-root"],
      }),
    );

    const orchestrator = new SubagentExpansionOrchestrator({
      retrieval,
      runSubagent,
    });

    const authorized = await orchestrator.expandDeep({
      targetIds: ["sum-alpha-root"],
      question: "Trace authorized path",
      sessionKey: "agent:main:subagent:runner",
      depth: 6,
      tokenCap: 6_000,
      strategy: "subagent",
    });

    expect(runSubagent).toHaveBeenCalledTimes(1);
    expect(runSubagent.mock.calls[0]?.[0].conversationIds).toEqual(["conv-alpha"]);
    expect(authorized.nextSummaryIds).toEqual([]);
    expect(authorized.warnings.some((warning) => warning.includes("sum-beta-root"))).toBe(true);

    await expect(
      orchestrator.expandDeep({
        targetIds: ["sum-beta-root"],
        question: "Attempt unauthorized traversal",
        sessionKey: "agent:main:subagent:runner",
        depth: 3,
        tokenCap: 2_000,
        strategy: "subagent",
      }),
    ).rejects.toThrow(/outside delegated expansion scope/i);
  });
});

async function createHarness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-lcm-security-regression-"));
  OPEN_DIRS.add(dir);

  const backend = createSqliteLcmStorageBackend({
    dbPath: path.join(dir, "lcm.sqlite"),
  });
  OPEN_BACKENDS.add(backend);
  await backend.migrate();

  seedConversationGraph(backend, {
    conversationId: "conv-alpha",
    summaryPrefix: "alpha",
    marker: "alpha-security-anchor",
    nowMs: 1_850_000_100_000,
  });
  seedConversationGraph(backend, {
    conversationId: "conv-beta",
    summaryPrefix: "beta",
    marker: "beta-security-anchor",
    nowMs: 1_850_000_200_000,
  });

  const expansionAuth = new ExpansionGrantRegistry();
  const retrieval = createLcmRetrievalEngine({
    backend,
    tokenEstimator: createPlaceholderTokenEstimator(),
    expansionAuth,
  });

  return { backend, retrieval, expansionAuth };
}

function seedConversationGraph(
  backend: ReturnType<typeof createSqliteLcmStorageBackend>,
  params: {
    conversationId: string;
    summaryPrefix: string;
    marker: string;
    nowMs: number;
  },
): void {
  const rootSummaryId = `sum-${params.summaryPrefix}-root`;
  const childSummaryId = `sum-${params.summaryPrefix}-child`;
  const messageId = `msg-${params.summaryPrefix}-1`;
  const messageItemId = `ctx-${params.summaryPrefix}-msg-1`;

  backend.execute(
    `INSERT INTO lcm_conversations (conversation_id, session_id, channel, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
    [params.conversationId, `${params.conversationId}-session`, "test", params.nowMs, params.nowMs],
  );

  backend.execute(
    `INSERT INTO lcm_messages (message_id, conversation_id, ordinal, role, author_id, content_text, payload_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      messageId,
      params.conversationId,
      1,
      "assistant",
      null,
      `Security trace includes ${params.marker}.`,
      "{}",
      params.nowMs + 1,
    ],
  );

  backend.execute(
    `INSERT INTO lcm_context_items (
      item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rootSummaryId,
      params.conversationId,
      null,
      "summary",
      0,
      `${params.summaryPrefix} root`,
      `Root summary for ${params.summaryPrefix}.`,
      "{}",
      0,
      params.nowMs + 2,
      params.nowMs + 2,
    ],
  );

  backend.execute(
    `INSERT INTO lcm_context_items (
      item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      childSummaryId,
      params.conversationId,
      null,
      "summary",
      1,
      `${params.summaryPrefix} child`,
      `Child summary cites ${params.marker}.`,
      "{}",
      0,
      params.nowMs + 3,
      params.nowMs + 3,
    ],
  );

  backend.execute(
    `INSERT INTO lcm_context_items (
      item_id, conversation_id, source_message_id, item_type, depth, title, body, metadata_json, tombstoned, created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      messageItemId,
      params.conversationId,
      messageId,
      "message",
      2,
      null,
      `Message reference with ${params.marker}.`,
      "{}",
      0,
      params.nowMs + 4,
      params.nowMs + 4,
    ],
  );

  backend.execute(
    `INSERT INTO lcm_lineage_edges (parent_item_id, child_item_id, relation, metadata_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
    [rootSummaryId, childSummaryId, "derived", "{}", params.nowMs + 5],
  );
  backend.execute(
    `INSERT INTO lcm_lineage_edges (parent_item_id, child_item_id, relation, metadata_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?)`,
    [childSummaryId, messageItemId, "derived", "{}", params.nowMs + 6],
  );
}
