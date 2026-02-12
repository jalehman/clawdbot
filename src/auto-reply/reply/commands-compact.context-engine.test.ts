import { describe, expect, it, vi, beforeEach } from "vitest";

const { testContextEngine } = vi.hoisted(() => ({
  testContextEngine: {
    id: "test-engine",
    ingest: vi.fn(async () => ({ messages: [] })),
    assemble: vi.fn(async () => ({ messages: [] })),
    compact: vi.fn(async () => ({ ok: true, compacted: false })),
  },
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn(),
  compactEmbeddedPiSession: vi.fn(async () => ({
    ok: true,
    compacted: true,
    result: {
      summary: "ok",
      firstKeptEntryId: "entry-1",
      tokensBefore: 1000,
      tokensAfter: 500,
    },
  })),
  isEmbeddedPiRunActive: vi.fn(() => false),
  waitForEmbeddedPiRunEnd: vi.fn(async () => {}),
}));

vi.mock("../../agents/context-engine-selection.js", () => ({
  resolveRuntimeContextEngine: vi.fn(() => ({
    engine: testContextEngine,
    resolvedId: "test-engine",
  })),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("../status.js", () => ({
  formatContextUsageShort: vi.fn(() => "context"),
  formatTokenCount: vi.fn((value: number) => `${value}`),
}));

vi.mock("./mentions.js", () => ({
  stripMentions: vi.fn((input: string) => input),
  stripStructuralPrefixes: vi.fn((input: string) => input),
}));

vi.mock("./session-updates.js", () => ({
  incrementCompactionCount: vi.fn(async () => {}),
}));

import { resolveRuntimeContextEngine } from "../../agents/context-engine-selection.js";
import { compactEmbeddedPiSession } from "../../agents/pi-embedded.js";
import { handleCompactCommand } from "./commands-compact.js";

const mockedCompactEmbeddedPiSession = vi.mocked(compactEmbeddedPiSession);
const mockedResolveRuntimeContextEngine = vi.mocked(resolveRuntimeContextEngine);

describe("handleCompactCommand context-engine routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedResolveRuntimeContextEngine.mockReturnValue({
      engine: testContextEngine,
      resolvedId: "test-engine",
    });
  });

  it("passes selected context engine into compactEmbeddedPiSession", async () => {
    const result = await handleCompactCommand(
      {
        ctx: { Body: "/compact keep decisions only" },
        cfg: {},
        command: {
          commandBodyNormalized: "/compact keep decisions only",
          isAuthorizedSender: true,
          senderId: "sender-1",
          channel: "telegram",
          senderIsOwner: true,
          ownerList: [],
        },
        sessionEntry: {
          sessionId: "session-1",
          groupId: "group-1",
          groupChannel: "#general",
          space: "space-1",
          spawnedBy: null,
        },
        sessionKey: "session-key",
        workspaceDir: "/tmp/workspace",
        resolveDefaultThinkingLevel: async () => "off",
        provider: "anthropic",
        model: "claude",
        contextTokens: 200_000,
        isGroup: false,
        resolvedVerboseLevel: "off",
        resolvedReasoningLevel: "off",
      } as Parameters<typeof handleCompactCommand>[0],
      false,
    );

    expect(mockedResolveRuntimeContextEngine).toHaveBeenCalledTimes(1);
    expect(mockedCompactEmbeddedPiSession).toHaveBeenCalledWith(
      expect.objectContaining({
        contextEngine: testContextEngine,
      }),
    );
    expect(result).toMatchObject({
      shouldContinue: false,
    });
  });
});
