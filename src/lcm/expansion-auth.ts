import crypto from "node:crypto";
import type { ConversationId } from "./types.js";

const DEFAULT_GRANT_TTL_MS = 120_000;
const MIN_GRANT_TTL_MS = 1_000;
const MAX_GRANT_TTL_MS = 900_000;
const MIN_DEPTH = 0;
const MAX_DEPTH = 8;
const MIN_TOKEN_CAP = 1;
const MAX_TOKEN_CAP = 20_000;

/**
 * One delegated expansion scope from a parent session to a child session.
 */
export type ExpansionGrant = {
  grantId: string;
  delegatorSessionKey: string;
  delegateSessionKey: string;
  conversationIds: ConversationId[];
  maxDepth: number;
  maxTokenCap: number;
  issuedAtMs: number;
  expiresAtMs: number;
};

/**
 * Input used to issue a new expansion grant.
 */
export type IssueExpansionGrantInput = {
  delegatorSessionKey: string;
  delegateSessionKey: string;
  conversationIds: ConversationId[] | string[];
  maxDepth: number;
  maxTokenCap: number;
  ttlMs?: number;
  nowMs?: number;
};

/**
 * Auth check request for retrieval operations.
 */
export type ExpansionAuthorizationRequest = {
  sessionKey?: string;
  conversationId?: ConversationId | string;
  depth?: number;
  tokenCap?: number;
  nowMs?: number;
};

/**
 * Stable authorization error codes for tests and callers.
 */
export type ExpansionAuthorizationErrorCode =
  | "expired"
  | "missing_conversation_scope"
  | "conversation_out_of_scope"
  | "depth_exceeded"
  | "token_cap_exceeded";

/**
 * Thrown when an expansion grant check fails.
 */
export class ExpansionAuthorizationError extends Error {
  readonly code: ExpansionAuthorizationErrorCode;

  /**
   * Build a typed authorization error.
   */
  constructor(code: ExpansionAuthorizationErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ExpansionAuthorizationError";
  }
}

/**
 * Validate one request against one grant.
 */
export function validateExpansionGrant(params: {
  grant: ExpansionGrant;
  conversationId?: ConversationId | string;
  depth?: number;
  tokenCap?: number;
  nowMs?: number;
}): { ok: true } | { ok: false; code: ExpansionAuthorizationErrorCode; message: string } {
  const nowMs = normalizeNowMs(params.nowMs);
  if (params.grant.expiresAtMs <= nowMs) {
    return {
      ok: false,
      code: "expired",
      message: `LCM expansion grant '${params.grant.grantId}' expired.`,
    };
  }

  const conversationId = normalizeConversationId(params.conversationId);
  if (!conversationId) {
    return {
      ok: false,
      code: "missing_conversation_scope",
      message: "LCM expansion authorization requires a scoped conversationId.",
    };
  }
  const scopedConversationId = conversationId as ConversationId;
  if (!params.grant.conversationIds.includes(scopedConversationId)) {
    return {
      ok: false,
      code: "conversation_out_of_scope",
      message: `Conversation '${conversationId}' is outside delegated expansion scope.`,
    };
  }

  const depth = normalizeOptionalInt(params.depth);
  if (depth !== undefined && depth > params.grant.maxDepth) {
    return {
      ok: false,
      code: "depth_exceeded",
      message: `Expansion depth ${depth} exceeds delegated maxDepth ${params.grant.maxDepth}.`,
    };
  }

  const tokenCap = normalizeOptionalInt(params.tokenCap);
  if (tokenCap !== undefined && tokenCap > params.grant.maxTokenCap) {
    return {
      ok: false,
      code: "token_cap_exceeded",
      message: `Expansion token cap ${tokenCap} exceeds delegated maxTokenCap ${params.grant.maxTokenCap}.`,
    };
  }

  return { ok: true };
}

/**
 * In-memory store for active expansion grants keyed by delegate session.
 */
export class ExpansionGrantRegistry {
  private readonly grantsByDelegate = new Map<string, ExpansionGrant[]>();

  /**
   * Create and store one delegated grant.
   */
  issueGrant(input: IssueExpansionGrantInput): ExpansionGrant {
    const delegatorSessionKey = normalizeSessionKey(input.delegatorSessionKey);
    const delegateSessionKey = normalizeSessionKey(input.delegateSessionKey);
    if (!delegatorSessionKey || !delegateSessionKey) {
      throw new Error("delegatorSessionKey and delegateSessionKey are required.");
    }

    const conversationIds = normalizeConversationIds(input.conversationIds);
    if (conversationIds.length === 0) {
      throw new Error("conversationIds must include at least one conversation id.");
    }

    const nowMs = normalizeNowMs(input.nowMs);
    const ttlMs = clampInt(input.ttlMs, DEFAULT_GRANT_TTL_MS, MIN_GRANT_TTL_MS, MAX_GRANT_TTL_MS);
    const grant: ExpansionGrant = {
      grantId: crypto.randomUUID(),
      delegatorSessionKey,
      delegateSessionKey,
      conversationIds,
      maxDepth: clampInt(input.maxDepth, 1, MIN_DEPTH, MAX_DEPTH),
      maxTokenCap: clampInt(input.maxTokenCap, 1_000, MIN_TOKEN_CAP, MAX_TOKEN_CAP),
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    };

    const grants = this.grantsByDelegate.get(delegateSessionKey) ?? [];
    grants.push(grant);
    this.grantsByDelegate.set(delegateSessionKey, grants);
    return grant;
  }

  /**
   * Remove all grants for one delegate session.
   */
  revokeSession(sessionKey?: string): void {
    const normalized = normalizeSessionKey(sessionKey);
    if (!normalized) {
      return;
    }
    this.grantsByDelegate.delete(normalized);
  }

  /**
   * True if a session currently has at least one unexpired grant.
   */
  hasActiveGrantForSession(sessionKey?: string, nowMs?: number): boolean {
    const normalized = normalizeSessionKey(sessionKey);
    if (!normalized) {
      return false;
    }
    const active = this.collectSessionGrants(normalized, normalizeNowMs(nowMs)).active;
    return active.length > 0;
  }

  /**
   * Validate one retrieval request against active grants for a session.
   *
   * Returns null when no grants exist for the session (main-agent flows).
   */
  authorize(request: ExpansionAuthorizationRequest): ExpansionGrant | null {
    const sessionKey = normalizeSessionKey(request.sessionKey);
    if (!sessionKey) {
      return null;
    }

    const nowMs = normalizeNowMs(request.nowMs);
    const { active, expiredCount } = this.collectSessionGrants(sessionKey, nowMs);
    if (active.length === 0) {
      if (expiredCount > 0) {
        throw new ExpansionAuthorizationError(
          "expired",
          `All expansion grants expired for session '${sessionKey}'.`,
        );
      }
      return null;
    }

    let lastFailure: ExpansionAuthorizationError | null = null;
    for (const grant of active) {
      const result = validateExpansionGrant({
        grant,
        conversationId: request.conversationId,
        depth: request.depth,
        tokenCap: request.tokenCap,
        nowMs,
      });
      if (result.ok) {
        return grant;
      }
      lastFailure = new ExpansionAuthorizationError(result.code, result.message);
    }

    if (lastFailure) {
      throw lastFailure;
    }
    return null;
  }

  /**
   * Return active grants and prune expired grants for a delegate session.
   */
  private collectSessionGrants(
    sessionKey: string,
    nowMs: number,
  ): { active: ExpansionGrant[]; expiredCount: number } {
    const grants = this.grantsByDelegate.get(sessionKey);
    if (!grants || grants.length === 0) {
      return { active: [], expiredCount: 0 };
    }

    const active: ExpansionGrant[] = [];
    let expiredCount = 0;
    for (const grant of grants) {
      if (grant.expiresAtMs <= nowMs) {
        expiredCount += 1;
        continue;
      }
      active.push(grant);
    }

    if (active.length === 0) {
      this.grantsByDelegate.delete(sessionKey);
    } else if (active.length !== grants.length) {
      this.grantsByDelegate.set(sessionKey, active);
    }

    return { active, expiredCount };
  }
}

function normalizeSessionKey(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeConversationIds(values: ConversationId[] | string[]): ConversationId[] {
  const seen = new Set<string>();
  const out: ConversationId[] = [];
  for (const raw of values) {
    const normalized = normalizeConversationId(raw);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized as ConversationId);
  }
  return out;
}

function normalizeConversationId(value?: ConversationId | string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeOptionalInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.trunc(value);
}

function normalizeNowMs(value?: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  return Date.now();
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.trunc(value);
  return Math.min(max, Math.max(min, normalized));
}
