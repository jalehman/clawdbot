import { describe, expect, it } from "vitest";
import { ExpansionAuthorizationError, ExpansionGrantRegistry } from "./expansion-auth.js";

describe("ExpansionGrantRegistry", () => {
  it("valid grant allows expansion", () => {
    const registry = new ExpansionGrantRegistry();
    const nowMs = 1_700_000_000_000;
    registry.issueGrant({
      delegatorSessionKey: "agent:main:main",
      delegateSessionKey: "agent:main:subagent:pass-1",
      conversationIds: ["conv-alpha"],
      maxDepth: 3,
      maxTokenCap: 4_000,
      ttlMs: 60_000,
      nowMs,
    });

    const grant = registry.authorize({
      sessionKey: "agent:main:subagent:pass-1",
      conversationId: "conv-alpha",
      depth: 2,
      tokenCap: 2_000,
      nowMs: nowMs + 10,
    });
    expect(grant).not.toBeNull();
    expect(grant?.conversationIds).toEqual(["conv-alpha"]);
  });

  it("expired grant is rejected", () => {
    const registry = new ExpansionGrantRegistry();
    const nowMs = 1_700_000_010_000;
    registry.issueGrant({
      delegatorSessionKey: "agent:main:main",
      delegateSessionKey: "agent:main:subagent:expired",
      conversationIds: ["conv-alpha"],
      maxDepth: 3,
      maxTokenCap: 4_000,
      ttlMs: 1_000,
      nowMs,
    });

    try {
      registry.authorize({
        sessionKey: "agent:main:subagent:expired",
        conversationId: "conv-alpha",
        depth: 1,
        tokenCap: 1_000,
        nowMs: nowMs + 2_000,
      });
      throw new Error("expected expired authorization failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ExpansionAuthorizationError);
      expect((error as ExpansionAuthorizationError).code).toBe("expired");
    }
  });

  it("out-of-scope conversation id is rejected", () => {
    const registry = new ExpansionGrantRegistry();
    const nowMs = 1_700_000_020_000;
    registry.issueGrant({
      delegatorSessionKey: "agent:main:main",
      delegateSessionKey: "agent:main:subagent:scope",
      conversationIds: ["conv-alpha"],
      maxDepth: 3,
      maxTokenCap: 4_000,
      ttlMs: 60_000,
      nowMs,
    });

    expect(() =>
      registry.authorize({
        sessionKey: "agent:main:subagent:scope",
        conversationId: "conv-beta",
        depth: 1,
        tokenCap: 1_000,
        nowMs: nowMs + 1,
      }),
    ).toThrow(/outside delegated expansion scope/i);
  });

  it("depth exceeding grant max is rejected", () => {
    const registry = new ExpansionGrantRegistry();
    const nowMs = 1_700_000_030_000;
    registry.issueGrant({
      delegatorSessionKey: "agent:main:main",
      delegateSessionKey: "agent:main:subagent:depth",
      conversationIds: ["conv-alpha"],
      maxDepth: 2,
      maxTokenCap: 4_000,
      ttlMs: 60_000,
      nowMs,
    });

    expect(() =>
      registry.authorize({
        sessionKey: "agent:main:subagent:depth",
        conversationId: "conv-alpha",
        depth: 3,
        tokenCap: 1_000,
        nowMs: nowMs + 1,
      }),
    ).toThrow(/exceeds delegated maxDepth/i);
  });

  it("token cap exceeding grant max is rejected", () => {
    const registry = new ExpansionGrantRegistry();
    const nowMs = 1_700_000_040_000;
    registry.issueGrant({
      delegatorSessionKey: "agent:main:main",
      delegateSessionKey: "agent:main:subagent:token",
      conversationIds: ["conv-alpha"],
      maxDepth: 3,
      maxTokenCap: 1_200,
      ttlMs: 60_000,
      nowMs,
    });

    expect(() =>
      registry.authorize({
        sessionKey: "agent:main:subagent:token",
        conversationId: "conv-alpha",
        depth: 2,
        tokenCap: 1_400,
        nowMs: nowMs + 1,
      }),
    ).toThrow(/exceeds delegated maxTokenCap/i);
  });
});
