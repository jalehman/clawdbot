import { describe, expect, it, vi } from "vitest";
import {
  applyPiAutoCompactionGuard,
  DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
  ensurePiCompactionReserveTokens,
  resolveCompactionReserveTokensFloor,
  shouldDisablePiAutoCompaction,
} from "./pi-settings.js";

describe("ensurePiCompactionReserveTokens", () => {
  it("bumps reserveTokens when below floor", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 16_384,
      applyOverrides: vi.fn(),
    };

    const result = ensurePiCompactionReserveTokens({ settingsManager });

    expect(result).toEqual({
      didOverride: true,
      reserveTokens: DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR,
    });
    expect(settingsManager.applyOverrides).toHaveBeenCalledWith({
      compaction: { reserveTokens: DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR },
    });
  });

  it("does not override when already above floor", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 32_000,
      applyOverrides: vi.fn(),
    };

    const result = ensurePiCompactionReserveTokens({ settingsManager });

    expect(result).toEqual({ didOverride: false, reserveTokens: 32_000 });
    expect(settingsManager.applyOverrides).not.toHaveBeenCalled();
  });
});

describe("resolveCompactionReserveTokensFloor", () => {
  it("returns the default when config is missing", () => {
    expect(resolveCompactionReserveTokensFloor()).toBe(DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR);
  });

  it("accepts configured floors, including zero", () => {
    expect(
      resolveCompactionReserveTokensFloor({
        agents: { defaults: { compaction: { reserveTokensFloor: 24_000 } } },
      }),
    ).toBe(24_000);
    expect(
      resolveCompactionReserveTokensFloor({
        agents: { defaults: { compaction: { reserveTokensFloor: 0 } } },
      }),
    ).toBe(0);
  });
});

describe("shouldDisablePiAutoCompaction", () => {
  it("disables when LCM is the active context engine", () => {
    expect(
      shouldDisablePiAutoCompaction({
        contextEngineId: "lcm",
        env: {},
      }),
    ).toBe(true);
  });

  it("disables when explicitly flagged via env", () => {
    expect(
      shouldDisablePiAutoCompaction({
        contextEngineId: "legacy",
        env: { LCM_AUTOCOMPACT_DISABLED: "true" },
      }),
    ).toBe(true);
  });

  it("keeps Pi auto-compaction enabled otherwise", () => {
    expect(
      shouldDisablePiAutoCompaction({
        contextEngineId: "legacy",
        env: {},
      }),
    ).toBe(false);
  });
});

describe("applyPiAutoCompactionGuard", () => {
  it("disables Pi auto-compaction when the LCM context engine is active", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      applyOverrides: vi.fn(),
      setCompactionEnabled: vi.fn(),
    };

    const result = applyPiAutoCompactionGuard({
      settingsManager,
      contextEngineId: "lcm",
      env: {},
    });

    expect(result).toEqual({ supported: true, disabled: true });
    expect(settingsManager.setCompactionEnabled).toHaveBeenCalledWith(false);
  });

  it("does not force compaction settings when guard conditions are not met", () => {
    const settingsManager = {
      getCompactionReserveTokens: () => 20_000,
      applyOverrides: vi.fn(),
      setCompactionEnabled: vi.fn(),
    };

    const result = applyPiAutoCompactionGuard({
      settingsManager,
      contextEngineId: "legacy",
      env: {},
    });

    expect(result).toEqual({ supported: true, disabled: false });
    expect(settingsManager.setCompactionEnabled).not.toHaveBeenCalled();
  });
});
