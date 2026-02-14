import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MessagePartRecord, MessageRecord, MessageRole } from "./store/conversation-store.js";
import type {
  SummaryRecord,
  ContextItemRecord,
  SummaryKind,
  LargeFileRecord,
} from "./store/summary-store.js";
import { ContextAssembler } from "./assembler.js";
import { CompactionEngine, type CompactionConfig } from "./compaction.js";
import { RetrievalEngine } from "./retrieval.js";

// ── Mock Store Factories ─────────────────────────────────────────────────────

function createMockConversationStore() {
  const conversations: any[] = [];
  const messages: MessageRecord[] = [];
  const messageParts: MessagePartRecord[] = [];
  let nextConvId = 1;
  let nextMsgId = 1;
  let nextPartId = 1;

  return {
    createConversation: vi.fn(async (input: { sessionId: string; title?: string }) => {
      const conv = {
        conversationId: nextConvId++,
        sessionId: input.sessionId,
        title: input.title ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      conversations.push(conv);
      return conv;
    }),
    getConversation: vi.fn(
      async (id: number) => conversations.find((c) => c.conversationId === id) ?? null,
    ),
    getConversationBySessionId: vi.fn(
      async (sid: string) => conversations.find((c) => c.sessionId === sid) ?? null,
    ),
    getOrCreateConversation: vi.fn(async (sid: string, title?: string) => {
      const existing = conversations.find((c) => c.sessionId === sid);
      if (existing) {
        return existing;
      }
      const conv = {
        conversationId: nextConvId++,
        sessionId: sid,
        title: title ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      conversations.push(conv);
      return conv;
    }),
    createMessage: vi.fn(
      async (input: {
        conversationId: number;
        seq: number;
        role: MessageRole;
        content: string;
        tokenCount: number;
      }) => {
        const msg: MessageRecord = {
          messageId: nextMsgId++,
          conversationId: input.conversationId,
          seq: input.seq,
          role: input.role,
          content: input.content,
          tokenCount: input.tokenCount,
          createdAt: new Date(),
        };
        messages.push(msg);
        return msg;
      },
    ),
    createMessageParts: vi.fn(
      async (
        messageId: number,
        parts: Array<{
          sessionId: string;
          partType: MessagePartRecord["partType"];
          ordinal: number;
          textContent?: string | null;
          toolCallId?: string | null;
          toolName?: string | null;
          toolInput?: string | null;
          toolOutput?: string | null;
          metadata?: string | null;
        }>,
      ) => {
        for (const part of parts) {
          messageParts.push({
            partId: `part-${nextPartId++}`,
            messageId,
            sessionId: part.sessionId,
            partType: part.partType,
            ordinal: part.ordinal,
            textContent: part.textContent ?? null,
            toolCallId: part.toolCallId ?? null,
            toolName: part.toolName ?? null,
            toolInput: part.toolInput ?? null,
            toolOutput: part.toolOutput ?? null,
            metadata: part.metadata ?? null,
          });
        }
      },
    ),
    getMessages: vi.fn(async (convId: number, opts?: { afterSeq?: number; limit?: number }) => {
      let filtered = messages.filter((m) => m.conversationId === convId);
      if (opts?.afterSeq != null) {
        filtered = filtered.filter((m) => m.seq > opts.afterSeq!);
      }
      filtered.sort((a, b) => a.seq - b.seq);
      if (opts?.limit) {
        filtered = filtered.slice(0, opts.limit);
      }
      return filtered;
    }),
    getMessageById: vi.fn(async (id: number) => messages.find((m) => m.messageId === id) ?? null),
    getMessageParts: vi.fn(async (messageId: number) =>
      messageParts
        .filter((part) => part.messageId === messageId)
        .sort((a, b) => a.ordinal - b.ordinal),
    ),
    getMessageCount: vi.fn(
      async (convId: number) => messages.filter((m) => m.conversationId === convId).length,
    ),
    getMaxSeq: vi.fn(async (convId: number) => {
      const convMsgs = messages.filter((m) => m.conversationId === convId);
      return convMsgs.length > 0 ? Math.max(...convMsgs.map((m) => m.seq)) : 0;
    }),
    searchMessages: vi.fn(
      async (input: { query: string; mode: string; conversationId?: number; limit?: number }) => {
        const limit = input.limit ?? 50;
        let filtered = messages;
        if (input.conversationId != null) {
          filtered = filtered.filter((m) => m.conversationId === input.conversationId);
        }
        // Simple in-memory search: check if content includes the query string
        filtered = filtered.filter((m) => m.content.includes(input.query));
        return filtered.slice(0, limit).map((m) => ({
          messageId: m.messageId,
          conversationId: m.conversationId,
          role: m.role,
          snippet: m.content.slice(0, 100),
          rank: 0,
        }));
      },
    ),
    // Expose internals for assertions
    _conversations: conversations,
    _messages: messages,
  };
}

function createMockSummaryStore() {
  const summaries: SummaryRecord[] = [];
  const contextItems: ContextItemRecord[] = [];
  const summaryMessages: Array<{ summaryId: string; messageId: number; ordinal: number }> = [];
  const summaryParents: Array<{
    summaryId: string;
    parentSummaryId: string;
    ordinal: number;
  }> = [];
  const largeFiles: LargeFileRecord[] = [];

  const store = {
    // ── Context items ───────────────────────────────────────────────────

    getContextItems: vi.fn(async (conversationId: number): Promise<ContextItemRecord[]> => {
      return contextItems
        .filter((ci) => ci.conversationId === conversationId)
        .toSorted((a, b) => a.ordinal - b.ordinal);
    }),

    appendContextMessage: vi.fn(
      async (conversationId: number, messageId: number): Promise<void> => {
        const existing = contextItems.filter((ci) => ci.conversationId === conversationId);
        const maxOrdinal = existing.length > 0 ? Math.max(...existing.map((ci) => ci.ordinal)) : -1;
        contextItems.push({
          conversationId,
          ordinal: maxOrdinal + 1,
          itemType: "message",
          messageId,
          summaryId: null,
          createdAt: new Date(),
        });
      },
    ),

    appendContextSummary: vi.fn(
      async (conversationId: number, summaryId: string): Promise<void> => {
        const existing = contextItems.filter((ci) => ci.conversationId === conversationId);
        const maxOrdinal = existing.length > 0 ? Math.max(...existing.map((ci) => ci.ordinal)) : -1;
        contextItems.push({
          conversationId,
          ordinal: maxOrdinal + 1,
          itemType: "summary",
          messageId: null,
          summaryId,
          createdAt: new Date(),
        });
      },
    ),

    replaceContextRangeWithSummary: vi.fn(
      async (input: {
        conversationId: number;
        startOrdinal: number;
        endOrdinal: number;
        summaryId: string;
      }): Promise<void> => {
        const { conversationId, startOrdinal, endOrdinal, summaryId } = input;

        // Remove items in the range [startOrdinal, endOrdinal]
        const toRemoveIndices: number[] = [];
        for (let i = contextItems.length - 1; i >= 0; i--) {
          const ci = contextItems[i];
          if (
            ci.conversationId === conversationId &&
            ci.ordinal >= startOrdinal &&
            ci.ordinal <= endOrdinal
          ) {
            toRemoveIndices.push(i);
          }
        }
        // Remove in reverse order so indices remain valid
        for (const idx of toRemoveIndices) {
          contextItems.splice(idx, 1);
        }

        // Insert replacement summary item at startOrdinal
        contextItems.push({
          conversationId,
          ordinal: startOrdinal,
          itemType: "summary",
          messageId: null,
          summaryId,
          createdAt: new Date(),
        });

        // Resequence: sort by ordinal then reassign dense ordinals 0..n-1
        const convItems = contextItems
          .filter((ci) => ci.conversationId === conversationId)
          .toSorted((a, b) => a.ordinal - b.ordinal);

        // Remove all conversation items, re-add with new ordinals
        for (let i = contextItems.length - 1; i >= 0; i--) {
          if (contextItems[i].conversationId === conversationId) {
            contextItems.splice(i, 1);
          }
        }
        for (let i = 0; i < convItems.length; i++) {
          convItems[i].ordinal = i;
          contextItems.push(convItems[i]);
        }
      },
    ),

    getContextTokenCount: vi.fn(async (conversationId: number): Promise<number> => {
      const items = contextItems.filter((ci) => ci.conversationId === conversationId);
      let total = 0;
      for (const item of items) {
        if (item.itemType === "message" && item.messageId != null) {
          // Look up the message's tokenCount from the conversation store
          // We need access to messages, but since the mock stores are created separately,
          // we store a reference to the message token counts here via a lookup helper
          const msgTokenCount = store._getMessageTokenCount(item.messageId);
          total += msgTokenCount;
        } else if (item.itemType === "summary" && item.summaryId != null) {
          const summary = summaries.find((s) => s.summaryId === item.summaryId);
          if (summary) {
            total += summary.tokenCount;
          }
        }
      }
      return total;
    }),

    // ── Summary CRUD ────────────────────────────────────────────────────

    insertSummary: vi.fn(
      async (input: {
        summaryId: string;
        conversationId: number;
        kind: SummaryKind;
        content: string;
        tokenCount: number;
        fileIds?: string[];
      }): Promise<SummaryRecord> => {
        const summary: SummaryRecord = {
          summaryId: input.summaryId,
          conversationId: input.conversationId,
          kind: input.kind,
          content: input.content,
          tokenCount: input.tokenCount,
          fileIds: input.fileIds ?? [],
          createdAt: new Date(),
        };
        summaries.push(summary);
        return summary;
      },
    ),

    getSummary: vi.fn(async (summaryId: string): Promise<SummaryRecord | null> => {
      return summaries.find((s) => s.summaryId === summaryId) ?? null;
    }),

    getSummariesByConversation: vi.fn(async (conversationId: number): Promise<SummaryRecord[]> => {
      return summaries
        .filter((s) => s.conversationId === conversationId)
        .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    }),

    // ── Lineage ─────────────────────────────────────────────────────────

    linkSummaryToMessages: vi.fn(async (summaryId: string, messageIds: number[]): Promise<void> => {
      for (let i = 0; i < messageIds.length; i++) {
        summaryMessages.push({
          summaryId,
          messageId: messageIds[i],
          ordinal: i,
        });
      }
    }),

    linkSummaryToParents: vi.fn(
      async (summaryId: string, parentSummaryIds: string[]): Promise<void> => {
        for (let i = 0; i < parentSummaryIds.length; i++) {
          summaryParents.push({
            summaryId,
            parentSummaryId: parentSummaryIds[i],
            ordinal: i,
          });
        }
      },
    ),

    getSummaryMessages: vi.fn(async (summaryId: string): Promise<number[]> => {
      return summaryMessages
        .filter((sm) => sm.summaryId === summaryId)
        .toSorted((a, b) => a.ordinal - b.ordinal)
        .map((sm) => sm.messageId);
    }),

    getSummaryParents: vi.fn(async (summaryId: string): Promise<SummaryRecord[]> => {
      const parentIds = new Set(
        summaryParents
          .filter((sp) => sp.summaryId === summaryId)
          .toSorted((a, b) => a.ordinal - b.ordinal)
          .map((sp) => sp.parentSummaryId),
      );
      return summaries.filter((s) => parentIds.has(s.summaryId));
    }),

    getSummaryChildren: vi.fn(async (parentSummaryId: string): Promise<SummaryRecord[]> => {
      const childIds = new Set(
        summaryParents
          .filter((sp) => sp.parentSummaryId === parentSummaryId)
          .toSorted((a, b) => a.ordinal - b.ordinal)
          .map((sp) => sp.summaryId),
      );
      return summaries.filter((s) => childIds.has(s.summaryId));
    }),

    // ── Search ──────────────────────────────────────────────────────────

    searchSummaries: vi.fn(
      async (input: { query: string; mode: string; conversationId?: number; limit?: number }) => {
        const limit = input.limit ?? 50;
        let filtered = summaries;
        if (input.conversationId != null) {
          filtered = filtered.filter((s) => s.conversationId === input.conversationId);
        }
        // Simple in-memory search
        filtered = filtered.filter((s) => s.content.includes(input.query));
        return filtered.slice(0, limit).map((s) => ({
          summaryId: s.summaryId,
          conversationId: s.conversationId,
          kind: s.kind,
          snippet: s.content.slice(0, 100),
          rank: 0,
        }));
      },
    ),

    // ── Large files ─────────────────────────────────────────────────────

    getLargeFile: vi.fn(async (fileId: string): Promise<LargeFileRecord | null> => {
      return largeFiles.find((f) => f.fileId === fileId) ?? null;
    }),

    insertLargeFile: vi.fn(async (input: any): Promise<LargeFileRecord> => {
      const file: LargeFileRecord = {
        fileId: input.fileId,
        conversationId: input.conversationId,
        fileName: input.fileName ?? null,
        mimeType: input.mimeType ?? null,
        byteSize: input.byteSize ?? null,
        storageUri: input.storageUri,
        explorationSummary: input.explorationSummary ?? null,
        createdAt: new Date(),
      };
      largeFiles.push(file);
      return file;
    }),

    getLargeFilesByConversation: vi.fn(
      async (conversationId: number): Promise<LargeFileRecord[]> => {
        return largeFiles.filter((f) => f.conversationId === conversationId);
      },
    ),

    // ── Internal helpers for the mock ────────────────────────────────────

    /** Callback used by getContextTokenCount to look up message tokens. */
    _getMessageTokenCount: (_messageId: number): number => 0,

    // Expose internals for assertions
    _summaries: summaries,
    _contextItems: contextItems,
    _summaryMessages: summaryMessages,
    _summaryParents: summaryParents,
    _largeFiles: largeFiles,
  };

  return store;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Rough token estimate matching the one used in the production code. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const rec = block as { text?: unknown };
      return typeof rec.text === "string" ? rec.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

const CONV_ID = 1;

/**
 * Ingest N messages into the mock stores, simulating what LcmContextEngine.ingest does:
 * 1. createMessage in the conversation store
 * 2. appendContextMessage in the summary store
 *
 * Returns the created MessageRecords.
 */
async function ingestMessages(
  convStore: ReturnType<typeof createMockConversationStore>,
  sumStore: ReturnType<typeof createMockSummaryStore>,
  count: number,
  opts?: {
    conversationId?: number;
    contentFn?: (i: number) => string;
    roleFn?: (i: number) => MessageRole;
    tokenCountFn?: (i: number, content: string) => number;
  },
): Promise<MessageRecord[]> {
  const conversationId = opts?.conversationId ?? CONV_ID;
  const records: MessageRecord[] = [];

  for (let i = 0; i < count; i++) {
    const content = opts?.contentFn ? opts.contentFn(i) : `Message ${i}`;
    const role: MessageRole = opts?.roleFn ? opts.roleFn(i) : i % 2 === 0 ? "user" : "assistant";
    const tokenCount = opts?.tokenCountFn ? opts.tokenCountFn(i, content) : estimateTokens(content);

    const msg = await convStore.createMessage({
      conversationId,
      seq: i + 1,
      role,
      content,
      tokenCount,
    });

    await sumStore.appendContextMessage(conversationId, msg.messageId);
    records.push(msg);
  }

  return records;
}

/**
 * Wire up the summary store's getContextTokenCount so it can look up
 * message token counts from the conversation store.
 */
function wireStores(
  convStore: ReturnType<typeof createMockConversationStore>,
  sumStore: ReturnType<typeof createMockSummaryStore>,
) {
  sumStore._getMessageTokenCount = (messageId: number): number => {
    const msg = convStore._messages.find((m) => m.messageId === messageId);
    return msg?.tokenCount ?? 0;
  };
}

// ── Default compaction config ────────────────────────────────────────────────

const defaultCompactionConfig: CompactionConfig = {
  contextThreshold: 0.75,
  freshTailCount: 4,
  leafTargetTokens: 600,
  condensedTargetTokens: 900,
  maxRounds: 10,
};

// ═════════════════════════════════════════════════════════════════════════════
// Test Suite: Ingest -> Assemble
// ═════════════════════════════════════════════════════════════════════════════

describe("LCM integration: ingest -> assemble", () => {
  let convStore: ReturnType<typeof createMockConversationStore>;
  let sumStore: ReturnType<typeof createMockSummaryStore>;
  let assembler: ContextAssembler;

  beforeEach(() => {
    convStore = createMockConversationStore();
    sumStore = createMockSummaryStore();
    wireStores(convStore, sumStore);
    assembler = new ContextAssembler(convStore as any, sumStore as any);
  });

  it("ingested messages appear in assembled context", async () => {
    // Ingest 5 messages
    const msgs = await ingestMessages(convStore, sumStore, 5);

    // Assemble with a large budget so nothing is dropped
    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 100_000,
    });

    // All 5 messages should appear
    expect(result.messages).toHaveLength(5);
    expect(result.stats.rawMessageCount).toBe(5);
    expect(result.stats.summaryCount).toBe(0);
    expect(result.stats.totalContextItems).toBe(5);

    // Verify chronological order by checking content
    for (let i = 0; i < 5; i++) {
      expect(extractMessageText(result.messages[i].content)).toBe(`Message ${i}`);
    }
  });

  it("assembler respects token budget by dropping oldest items", async () => {
    // Ingest 10 messages with known token counts (each ~100 tokens via content length)
    const msgs = await ingestMessages(convStore, sumStore, 10, {
      contentFn: (i) => `M${i} ${"x".repeat(396)}`, // each message ~100 tokens
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    // Each message is ~100 tokens. Budget of 500 tokens with freshTailCount=4 means:
    // Fresh tail = last 4 items = ~400 tokens
    // Remaining budget = 500 - 400 = 100 tokens -> fits 1 more evictable item
    // So we should see items from index 5..9 (fresh tail) + maybe index 5 from evictable
    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 500,
      freshTailCount: 4,
    });

    // Fresh tail (last 4) should always be included
    const lastFour = result.messages.slice(-4);
    for (let i = 0; i < 4; i++) {
      expect(extractMessageText(lastFour[i].content)).toContain(`M${6 + i}`);
    }

    // We should have fewer than 10 messages total (oldest dropped)
    expect(result.messages.length).toBeLessThan(10);

    // The oldest messages should be the ones dropped
    // With 100 tokens remaining budget and each msg ~100 tokens, we get at most 1 extra
    expect(result.messages.length).toBeLessThanOrEqual(5);
  });

  it("assembler includes summaries alongside messages", async () => {
    // Add 2 messages
    await ingestMessages(convStore, sumStore, 2);

    // Add a summary to the summary store and to context items
    const summaryId = "sum_test_001";
    await sumStore.insertSummary({
      summaryId,
      conversationId: CONV_ID,
      kind: "leaf",
      content: "This is a leaf summary of earlier conversation.",
      tokenCount: 20,
    });
    await sumStore.appendContextSummary(CONV_ID, summaryId);

    // Add 2 more messages after the summary
    const laterMsgs = await ingestMessages(convStore, sumStore, 2, {
      contentFn: (i) => `Later message ${i}`,
    });

    // Assemble with large budget
    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 100_000,
    });

    // Should have 4 messages + 1 summary = 5 items total
    expect(result.messages).toHaveLength(5);
    expect(result.stats.rawMessageCount).toBe(4);
    expect(result.stats.summaryCount).toBe(1);

    // The summary should appear as a user message with the [Summary ID: ...] header
    const summaryMsg = result.messages.find((m) =>
      m.content.includes("[Summary ID: sum_test_001]"),
    );
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.role).toBe("user");
    expect(summaryMsg!.content).toContain("This is a leaf summary");
  });

  it("empty conversation returns empty result", async () => {
    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 100_000,
    });

    expect(result.messages).toHaveLength(0);
    expect(result.estimatedTokens).toBe(0);
    expect(result.stats.totalContextItems).toBe(0);
  });

  it("fresh tail is always preserved even when over budget", async () => {
    // Ingest 3 messages, each ~200 tokens
    await ingestMessages(convStore, sumStore, 3, {
      contentFn: (i) => `M${i} ${"y".repeat(796)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    // Budget is only 100 tokens but freshTailCount=8 means all 3 are "fresh"
    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 100,
      freshTailCount: 8,
    });

    // All 3 messages should still be present (fresh tail is never dropped)
    expect(result.messages).toHaveLength(3);
  });

  it("degrades tool rows without toolCallId to assistant text", async () => {
    await ingestMessages(convStore, sumStore, 1, {
      roleFn: () => "tool",
      contentFn: () => "legacy tool output without call id",
    });

    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 100_000,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("assistant");
    expect(extractMessageText(result.messages[0].content)).toContain(
      "legacy tool output without call id",
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Test Suite: Compaction
// ═════════════════════════════════════════════════════════════════════════════

describe("LCM integration: compaction", () => {
  let convStore: ReturnType<typeof createMockConversationStore>;
  let sumStore: ReturnType<typeof createMockSummaryStore>;
  let compactionEngine: CompactionEngine;

  beforeEach(() => {
    convStore = createMockConversationStore();
    sumStore = createMockSummaryStore();
    wireStores(convStore, sumStore);
    compactionEngine = new CompactionEngine(
      convStore as any,
      sumStore as any,
      defaultCompactionConfig,
    );
  });

  it("compaction creates leaf summary from oldest messages", async () => {
    // Ingest 10 messages
    await ingestMessages(convStore, sumStore, 10, {
      contentFn: (i) => `Turn ${i}: discussion about topic ${i}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    // Summarize stub that produces shorter output
    const summarize = vi.fn(async (text: string, aggressive?: boolean) => {
      return `Summary: condensed version of ${text.length} chars`;
    });

    const result = await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    // A compaction should have occurred
    expect(result.actionTaken).toBe(true);
    expect(result.createdSummaryId).toBeDefined();
    expect(result.createdSummaryId!.startsWith("sum_")).toBe(true);

    // A leaf summary should have been inserted into the summary store
    const allSummaries = sumStore._summaries;
    expect(allSummaries.length).toBeGreaterThanOrEqual(1);
    const leafSummary = allSummaries.find((s) => s.kind === "leaf");
    expect(leafSummary).toBeDefined();
    expect(leafSummary!.content).toContain("Summary:");

    // Context items should now include a summary item
    const contextItems = await sumStore.getContextItems(CONV_ID);
    const summaryItems = contextItems.filter((ci) => ci.itemType === "summary");
    expect(summaryItems.length).toBeGreaterThanOrEqual(1);

    // Total context items should be fewer than the original 10
    expect(contextItems.length).toBeLessThan(10);
  });

  it("compaction escalates to aggressive when normal does not converge", async () => {
    // Ingest messages
    await ingestMessages(convStore, sumStore, 8, {
      contentFn: (i) => `Content ${i}: ${"a".repeat(200)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    let normalCallCount = 0;
    let aggressiveCallCount = 0;

    // Normal summarize returns text >= input size (no convergence)
    // Aggressive summarize returns shorter text
    const summarize = vi.fn(async (text: string, aggressive?: boolean) => {
      if (!aggressive) {
        normalCallCount++;
        // Return something at least as long as input => no convergence
        return text + " (expanded, not summarized)";
      } else {
        aggressiveCallCount++;
        // Return much shorter text => converges
        return "Aggressively summarized.";
      }
    });

    const result = await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);
    // Normal was called first but didn't converge, so aggressive was called
    expect(normalCallCount).toBeGreaterThanOrEqual(1);
    expect(aggressiveCallCount).toBeGreaterThanOrEqual(1);
    expect(result.level).toBe("aggressive");
  });

  it("compaction falls back to truncation when aggressive does not converge", async () => {
    // Ingest messages
    await ingestMessages(convStore, sumStore, 8, {
      contentFn: (i) => `Content ${i}: ${"b".repeat(200)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    // Both normal and aggressive return >= input size
    const summarize = vi.fn(async (text: string, _aggressive?: boolean) => {
      return text + " (not actually summarized)";
    });

    const result = await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);
    expect(result.level).toBe("fallback");

    // The created summary should contain the truncation marker
    const leafSummary = sumStore._summaries.find((s) => s.kind === "leaf");
    expect(leafSummary).toBeDefined();
    expect(leafSummary!.content).toContain("[Truncated from");
    expect(leafSummary!.content).toContain("tokens]");
  });

  it("compactUntilUnder loops until under budget", async () => {
    // Ingest many messages with substantial token counts
    await ingestMessages(convStore, sumStore, 20, {
      contentFn: (i) => `Turn ${i}: ${"c".repeat(200)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    let callCount = 0;
    // Each summarize call produces a short summary, so each round makes progress
    const summarize = vi.fn(async (text: string, _aggressive?: boolean) => {
      callCount++;
      return `Round ${callCount} summary of ${text.length} chars.`;
    });

    // Set a tight budget that requires multiple rounds
    // Each message is ~52 tokens; 20 messages = ~1040 tokens total.
    // Set budget to 200 tokens to force multiple compaction rounds.
    const result = await compactionEngine.compactUntilUnder({
      conversationId: CONV_ID,
      tokenBudget: 200,
      summarize,
    });

    // Multiple rounds should have been needed
    expect(result.rounds).toBeGreaterThan(1);
    // Final tokens should be at or under budget (or we ran out of rounds)
    if (result.success) {
      expect(result.finalTokens).toBeLessThanOrEqual(200);
    }
  });

  it("compactUntilUnder respects an explicit threshold target", async () => {
    await ingestMessages(convStore, sumStore, 16, {
      contentFn: (i) => `Turn ${i}: ${"z".repeat(220)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const summarize = vi.fn(async (text: string) => {
      return `summary ${text.length}`;
    });

    const result = await compactionEngine.compactUntilUnder({
      conversationId: CONV_ID,
      tokenBudget: 600,
      targetTokens: 450,
      summarize,
    });

    expect(result.success).toBe(true);
    expect(result.finalTokens).toBeLessThanOrEqual(450);
  });

  it("evaluate returns shouldCompact=false when under threshold", async () => {
    await ingestMessages(convStore, sumStore, 2, {
      contentFn: () => "Short msg",
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const decision = await compactionEngine.evaluate(CONV_ID, 100_000);
    expect(decision.shouldCompact).toBe(false);
    expect(decision.reason).toBe("none");
  });

  it("evaluate returns shouldCompact=true when over threshold", async () => {
    // Ingest enough messages to exceed 75% of a small budget
    await ingestMessages(convStore, sumStore, 10, {
      contentFn: (i) => `Message ${i}: ${"d".repeat(200)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    // Each message ~53 tokens, total ~530 tokens. Budget=600 => threshold=450
    const decision = await compactionEngine.evaluate(CONV_ID, 600);
    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe("threshold");
    expect(decision.currentTokens).toBeGreaterThan(decision.threshold);
  });

  it("evaluate uses observed live token count when it exceeds stored count", async () => {
    await ingestMessages(convStore, sumStore, 2, {
      contentFn: () => "Short msg",
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const decision = await compactionEngine.evaluate(CONV_ID, 600, 500);
    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe("threshold");
    expect(decision.currentTokens).toBe(500);
    expect(decision.threshold).toBe(450);
  });

  it("compactUntilUnder uses currentTokens when stored tokens are stale", async () => {
    await ingestMessages(convStore, sumStore, 10, {
      contentFn: (i) => `Turn ${i}: ${"x".repeat(200)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const summarize = vi.fn(async (text: string) => {
      return `summary ${text.length}`;
    });

    const result = await compactionEngine.compactUntilUnder({
      conversationId: CONV_ID,
      tokenBudget: 2_000,
      targetTokens: 1_000,
      currentTokens: 1_500,
      summarize,
    });

    expect(result.rounds).toBeGreaterThanOrEqual(1);
    expect(summarize).toHaveBeenCalled();
  });

  it("compact skips when under threshold and not forced", async () => {
    await ingestMessages(convStore, sumStore, 2, {
      contentFn: () => "Short",
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const summarize = vi.fn(async () => "should not be called");

    const result = await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 100_000,
      summarize,
    });

    expect(result.actionTaken).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Test Suite: Retrieval
// ═════════════════════════════════════════════════════════════════════════════

describe("LCM integration: retrieval", () => {
  let convStore: ReturnType<typeof createMockConversationStore>;
  let sumStore: ReturnType<typeof createMockSummaryStore>;
  let retrieval: RetrievalEngine;

  beforeEach(() => {
    convStore = createMockConversationStore();
    sumStore = createMockSummaryStore();
    wireStores(convStore, sumStore);
    retrieval = new RetrievalEngine(convStore as any, sumStore as any);
  });

  it("describe returns summary with lineage", async () => {
    // Create messages first
    const msgs = await ingestMessages(convStore, sumStore, 3);

    // Insert a leaf summary linked to those messages
    const summaryId = "sum_leaf_abc123";
    await sumStore.insertSummary({
      summaryId,
      conversationId: CONV_ID,
      kind: "leaf",
      content: "Summary of messages 1-3 about testing.",
      tokenCount: 20,
    });
    await sumStore.linkSummaryToMessages(
      summaryId,
      msgs.map((m) => m.messageId),
    );

    // Describe it
    const result = await retrieval.describe(summaryId);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(summaryId);
    expect(result!.type).toBe("summary");
    expect(result!.summary).toBeDefined();
    expect(result!.summary!.kind).toBe("leaf");
    expect(result!.summary!.content).toContain("Summary of messages 1-3");
    expect(result!.summary!.messageIds).toEqual(msgs.map((m) => m.messageId));
    expect(result!.summary!.parentIds).toEqual([]);
    expect(result!.summary!.childIds).toEqual([]);
  });

  it("describe returns file info for file IDs", async () => {
    await sumStore.insertLargeFile({
      fileId: "file_test_001",
      conversationId: CONV_ID,
      fileName: "data.csv",
      mimeType: "text/csv",
      byteSize: 1024,
      storageUri: "s3://bucket/data.csv",
      explorationSummary: "CSV with 100 rows of test data.",
    });

    const result = await retrieval.describe("file_test_001");

    expect(result).not.toBeNull();
    expect(result!.type).toBe("file");
    expect(result!.file).toBeDefined();
    expect(result!.file!.fileName).toBe("data.csv");
    expect(result!.file!.storageUri).toBe("s3://bucket/data.csv");
  });

  it("describe returns null for unknown IDs", async () => {
    const result = await retrieval.describe("sum_nonexistent");
    expect(result).toBeNull();
  });

  it("grep searches across messages and summaries", async () => {
    // Insert messages with searchable content
    await ingestMessages(convStore, sumStore, 5, {
      contentFn: (i) =>
        i === 2 ? "This message mentions the deployment bug" : `Regular message ${i}`,
    });

    // Insert a summary with searchable content
    await sumStore.insertSummary({
      summaryId: "sum_search_001",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "Summary mentioning the deployment bug fix.",
      tokenCount: 15,
    });

    const result = await retrieval.grep({
      query: "deployment",
      mode: "full_text",
      scope: "both",
      conversationId: CONV_ID,
    });

    expect(result.totalMatches).toBeGreaterThanOrEqual(2);
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.summaries.length).toBeGreaterThanOrEqual(1);
  });

  it("grep respects scope=messages to only search messages", async () => {
    await ingestMessages(convStore, sumStore, 3, {
      contentFn: (i) => `Message about feature ${i}`,
    });

    await sumStore.insertSummary({
      summaryId: "sum_scope_001",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "Summary about feature improvements.",
      tokenCount: 10,
    });

    const result = await retrieval.grep({
      query: "feature",
      mode: "full_text",
      scope: "messages",
      conversationId: CONV_ID,
    });

    // Only messages should be searched
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.summaries).toEqual([]);
  });

  it("expand returns children of a condensed parent summary", async () => {
    // Create a condensed parent summary
    await sumStore.insertSummary({
      summaryId: "sum_parent",
      conversationId: CONV_ID,
      kind: "condensed",
      content: "High-level condensed summary.",
      tokenCount: 10,
    });

    // Create child leaf summaries that point to the parent
    await sumStore.insertSummary({
      summaryId: "sum_child_1",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "Child leaf 1: authentication flow details.",
      tokenCount: 15,
    });
    await sumStore.insertSummary({
      summaryId: "sum_child_2",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "Child leaf 2: database migration details.",
      tokenCount: 15,
    });

    // Link children to parent: each child has sum_parent as its parent
    await sumStore.linkSummaryToParents("sum_child_1", ["sum_parent"]);
    await sumStore.linkSummaryToParents("sum_child_2", ["sum_parent"]);

    const result = await retrieval.expand({
      summaryId: "sum_parent",
      depth: 1,
      includeMessages: false,
    });

    expect(result.children).toHaveLength(2);
    expect(result.children.map((c) => c.summaryId)).toContain("sum_child_1");
    expect(result.children.map((c) => c.summaryId)).toContain("sum_child_2");
    expect(result.truncated).toBe(false);
  });

  it("expand respects tokenCap", async () => {
    // Create parent
    await sumStore.insertSummary({
      summaryId: "sum_big_parent",
      conversationId: CONV_ID,
      kind: "condensed",
      content: "Parent summary.",
      tokenCount: 5,
    });

    // Create children with large token counts
    await sumStore.insertSummary({
      summaryId: "sum_big_child_1",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "A".repeat(400), // ~100 tokens
      tokenCount: 100,
    });
    await sumStore.insertSummary({
      summaryId: "sum_big_child_2",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "B".repeat(400), // ~100 tokens
      tokenCount: 100,
    });
    await sumStore.insertSummary({
      summaryId: "sum_big_child_3",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "C".repeat(400), // ~100 tokens
      tokenCount: 100,
    });

    await sumStore.linkSummaryToParents("sum_big_child_1", ["sum_big_parent"]);
    await sumStore.linkSummaryToParents("sum_big_child_2", ["sum_big_parent"]);
    await sumStore.linkSummaryToParents("sum_big_child_3", ["sum_big_parent"]);

    // Expand with a cap of 150 tokens — should fit child 1 (100) but not child 2
    const result = await retrieval.expand({
      summaryId: "sum_big_parent",
      depth: 1,
      tokenCap: 150,
    });

    expect(result.truncated).toBe(true);
    expect(result.children.length).toBeLessThan(3);
    expect(result.estimatedTokens).toBeLessThanOrEqual(150);
  });

  it("expand includes source messages at leaf level when includeMessages=true", async () => {
    // Create messages
    const msgs = await ingestMessages(convStore, sumStore, 3, {
      contentFn: (i) => `Source message ${i}`,
    });

    // Create leaf summary linked to those messages
    const leafId = "sum_leaf_with_msgs";
    await sumStore.insertSummary({
      summaryId: leafId,
      conversationId: CONV_ID,
      kind: "leaf",
      content: "Leaf summary of 3 messages.",
      tokenCount: 10,
    });
    await sumStore.linkSummaryToMessages(
      leafId,
      msgs.map((m) => m.messageId),
    );

    const result = await retrieval.expand({
      summaryId: leafId,
      depth: 1,
      includeMessages: true,
    });

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].content).toBe("Source message 0");
    expect(result.messages[1].content).toBe("Source message 1");
    expect(result.messages[2].content).toBe("Source message 2");
  });

  it("expand recurses through multiple depth levels", async () => {
    // Build a 3-level hierarchy: grandparent -> parent -> leaf children
    await sumStore.insertSummary({
      summaryId: "sum_grandparent",
      conversationId: CONV_ID,
      kind: "condensed",
      content: "Grandparent condensed.",
      tokenCount: 10,
    });

    await sumStore.insertSummary({
      summaryId: "sum_mid_parent",
      conversationId: CONV_ID,
      kind: "condensed",
      content: "Mid-level condensed parent.",
      tokenCount: 10,
    });
    // mid_parent is a child of grandparent
    await sumStore.linkSummaryToParents("sum_mid_parent", ["sum_grandparent"]);

    await sumStore.insertSummary({
      summaryId: "sum_deep_leaf",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "Deep leaf summary.",
      tokenCount: 10,
    });
    // deep_leaf is a child of mid_parent
    await sumStore.linkSummaryToParents("sum_deep_leaf", ["sum_mid_parent"]);

    // Expand grandparent with depth=2 to reach deep_leaf
    const result = await retrieval.expand({
      summaryId: "sum_grandparent",
      depth: 2,
    });

    // Should include mid_parent (depth 1) and deep_leaf (depth 2)
    const childIds = result.children.map((c) => c.summaryId);
    expect(childIds).toContain("sum_mid_parent");
    expect(childIds).toContain("sum_deep_leaf");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Test Suite: Full Round-Trip (ingest -> compact -> assemble -> retrieve)
// ═════════════════════════════════════════════════════════════════════════════

describe("LCM integration: full round-trip", () => {
  let convStore: ReturnType<typeof createMockConversationStore>;
  let sumStore: ReturnType<typeof createMockSummaryStore>;
  let assembler: ContextAssembler;
  let compactionEngine: CompactionEngine;
  let retrieval: RetrievalEngine;

  beforeEach(() => {
    convStore = createMockConversationStore();
    sumStore = createMockSummaryStore();
    wireStores(convStore, sumStore);
    assembler = new ContextAssembler(convStore as any, sumStore as any);
    compactionEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 4,
    });
    retrieval = new RetrievalEngine(convStore as any, sumStore as any);
  });

  it("messages survive compaction and remain retrievable", async () => {
    // 1. Ingest 20 messages
    const msgs = await ingestMessages(convStore, sumStore, 20, {
      contentFn: (i) => `Discussion turn ${i}: topic about integration testing.`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    // Verify all 20 are in context before compaction
    const contextBefore = await sumStore.getContextItems(CONV_ID);
    expect(contextBefore).toHaveLength(20);

    // 2. Compact (creates summaries)
    let summarizeCallCount = 0;
    const summarize = vi.fn(async (text: string, _aggressive?: boolean) => {
      summarizeCallCount++;
      return `Compacted summary #${summarizeCallCount}: covered ${text.length} chars of discussion.`;
    });

    const compactResult = await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    expect(compactResult.actionTaken).toBe(true);
    expect(compactResult.createdSummaryId).toBeDefined();

    // 3. Assemble (should include summaries + fresh messages)
    const assembleResult = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 100_000,
    });

    // Should have fewer items than 20 (some messages replaced by summaries)
    expect(assembleResult.stats.totalContextItems).toBeLessThan(20);
    expect(assembleResult.stats.summaryCount).toBeGreaterThanOrEqual(1);
    // Fresh tail messages should still be present
    expect(assembleResult.stats.rawMessageCount).toBeGreaterThan(0);

    // At least one assembled message should contain summary content
    const hasSummary = assembleResult.messages.some((m) => m.content.includes("[Summary ID:"));
    expect(hasSummary).toBe(true);

    // Fresh tail messages (last 4) should be present
    const lastMsgContent = assembleResult.messages[assembleResult.messages.length - 1].content;
    expect(extractMessageText(lastMsgContent)).toContain("Discussion turn 19");

    // 4. Use retrieval to describe the created summary
    const createdSummaryId = compactResult.createdSummaryId!;
    const describeResult = await retrieval.describe(createdSummaryId);

    expect(describeResult).not.toBeNull();
    expect(describeResult!.type).toBe("summary");
    expect(describeResult!.summary!.content).toContain("Compacted summary");

    // 5. Expand the summary to verify original messages are linked
    const expandResult = await retrieval.expand({
      summaryId: createdSummaryId,
      depth: 1,
      includeMessages: true,
    });

    // If it's a leaf summary, source messages should be retrievable
    if (describeResult!.summary!.kind === "leaf") {
      expect(expandResult.messages.length).toBeGreaterThan(0);
      // Each expanded message should have the original content
      for (const msg of expandResult.messages) {
        expect(msg.content).toContain("Discussion turn");
      }
    }
  });

  it("multiple compaction rounds create a summary DAG", async () => {
    // Ingest 12 messages with substantial content so that after the leaf pass,
    // the remaining context (1 small summary + 4 fresh messages) still exceeds
    // the threshold, forcing the condensed pass to run on the second round.
    await ingestMessages(convStore, sumStore, 12, {
      contentFn: (i) => `Turn ${i}: ${"z".repeat(200)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    let callNum = 0;
    const summarize = vi.fn(async (text: string, _aggressive?: boolean) => {
      callNum++;
      return `Summary round ${callNum}.`;
    });

    // First compaction with a tight budget.
    // 12 messages at ~52 tokens each = ~624 total tokens.
    // With budget=200, threshold=150. The leaf pass compacts the 8 oldest
    // messages into a ~5-token summary. After leaf pass:
    //   context = 1 summary (~5 tok) + 4 fresh messages (~208 tok) = ~213 tok
    // 213 > 150 (threshold), so the condensed pass also runs, creating
    // a condensed summary from the leaf. Result: 2 summaries in the store.
    const round1 = await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 200,
      summarize,
      force: true,
    });
    expect(round1.actionTaken).toBe(true);
    expect(round1.condensed).toBe(true);

    // The first round should have created both a leaf AND a condensed summary
    expect(sumStore._summaries.length).toBeGreaterThanOrEqual(2);

    const allSummaries = sumStore._summaries;
    const condensedSummaries = allSummaries.filter((s) => s.kind === "condensed");
    const leafSummaries = allSummaries.filter((s) => s.kind === "leaf");

    // We should have at least one of each kind
    expect(leafSummaries.length).toBeGreaterThanOrEqual(1);
    expect(condensedSummaries.length).toBeGreaterThanOrEqual(1);

    // The condensed summary should have lineage to the leaf
    const condensed = condensedSummaries[0];
    const parents = sumStore._summaryParents.filter((sp) => sp.summaryId === condensed.summaryId);
    expect(parents.length).toBeGreaterThanOrEqual(1);
    // The parent of the condensed summary should be the leaf summary
    expect(parents.some((p) => leafSummaries.some((l) => l.summaryId === p.parentSummaryId))).toBe(
      true,
    );
  });

  it("assembled context maintains correct message ordering after compaction", async () => {
    // Ingest 10 messages with sequential numbering
    await ingestMessages(convStore, sumStore, 10, {
      contentFn: (i) => `Sequential message #${i}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const summarize = vi.fn(async (text: string) => {
      return `Summary of early messages.`;
    });

    // Compact
    await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    // Assemble
    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 100_000,
    });

    // The summary should come before the fresh tail messages
    let sawSummary = false;
    let sawFreshAfterSummary = false;
    for (const msg of result.messages) {
      if (msg.content.includes("[Summary ID:")) {
        sawSummary = true;
      } else if (sawSummary && msg.content.includes("Sequential message")) {
        sawFreshAfterSummary = true;
      }
    }

    // Summary should appear before the fresh tail messages
    expect(sawSummary).toBe(true);
    expect(sawFreshAfterSummary).toBe(true);
  });

  it("grep finds content in both original messages and summaries after compaction", async () => {
    // Ingest messages with a unique keyword
    await ingestMessages(convStore, sumStore, 8, {
      contentFn: (i) =>
        i === 3 ? "The flamingo module has a critical bug in production" : `Normal turn ${i}`,
    });

    const summarize = vi.fn(async (text: string) => {
      // Summarize preserves key terms
      if (text.includes("flamingo")) {
        return "Summary: discussed flamingo module bug.";
      }
      return "Summary of normal discussion.";
    });

    await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    // Search for "flamingo" across both messages and summaries
    const grepResult = await retrieval.grep({
      query: "flamingo",
      mode: "full_text",
      scope: "both",
      conversationId: CONV_ID,
    });

    // The original message and/or the summary should match
    expect(grepResult.totalMatches).toBeGreaterThanOrEqual(1);
  });
});
