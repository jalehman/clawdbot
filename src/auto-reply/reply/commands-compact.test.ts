import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handleCompactCommand } from "./commands-compact.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const { mockedContextCompact } = vi.hoisted(() => ({
  mockedContextCompact: vi.fn(),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn(),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  waitForEmbeddedPiRunEnd: vi.fn().mockResolvedValue(undefined),
  resolveEmbeddedSessionLane: vi.fn().mockReturnValue("default"),
}));

vi.mock("../../context-engine/index.js", () => ({
  ensureContextEnginesInitialized: vi.fn(),
  resolveContextEngine: vi.fn(async () => ({
    compact: mockedContextCompact,
  })),
}));

vi.mock("../../process/command-queue.js", () => ({
  enqueueCommandInLane: vi.fn((_lane: string, task: () => unknown) => task()),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./session-updates.js", () => ({
  incrementCompactionCount: vi.fn(),
}));

describe("/compact command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when command is not /compact", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildCommandTestParams("/status", cfg);

    const result = await handleCompactCommand(
      {
        ...params,
      },
      true,
    );

    expect(result).toBeNull();
    expect(mockedContextCompact).not.toHaveBeenCalled();
  });

  it("rejects unauthorized /compact commands", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildCommandTestParams("/compact", cfg);

    const result = await handleCompactCommand(
      {
        ...params,
        command: {
          ...params.command,
          isAuthorizedSender: false,
          senderId: "unauthorized",
        },
      },
      true,
    );

    expect(result).toEqual({ shouldContinue: false });
    expect(mockedContextCompact).not.toHaveBeenCalled();
  });

  it("routes manual compaction with explicit trigger and context metadata", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: "/tmp/openclaw-session-store.json" },
    } as OpenClawConfig;
    const params = buildCommandTestParams("/compact: focus on decisions", cfg, {
      From: "+15550001",
      To: "+15550002",
    });
    mockedContextCompact.mockResolvedValueOnce({
      ok: true,
      compacted: false,
    });

    const result = await handleCompactCommand(
      {
        ...params,
        sessionEntry: {
          sessionId: "session-1",
          groupId: "group-1",
          groupChannel: "#general",
          space: "workspace-1",
          spawnedBy: "agent:main:parent",
          totalTokens: 12345,
        },
      },
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(mockedContextCompact).toHaveBeenCalledOnce();
    expect(mockedContextCompact).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        customInstructions: "focus on decisions",
        legacyParams: expect.objectContaining({
          sessionKey: "agent:main:main",
          trigger: "manual",
          messageChannel: "whatsapp",
          messageProvider: "whatsapp",
          groupId: "group-1",
          groupChannel: "#general",
          groupSpace: "workspace-1",
          spawnedBy: "agent:main:parent",
        }),
      }),
    );
  });
});
