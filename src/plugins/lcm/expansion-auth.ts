import type {
  ExpansionOrchestrator,
  ExpansionRequest,
  ExpansionResult,
} from "./expansion.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type ExpansionGrant = {
  /** Unique grant ID */
  grantId: string;
  /** Session ID that issued the grant */
  issuerSessionId: string;
  /** Conversation IDs the grantee is allowed to traverse */
  allowedConversationIds: number[];
  /** Specific summary IDs the grantee is allowed to expand (if empty, all within conversation are allowed) */
  allowedSummaryIds: string[];
  /** Maximum traversal depth */
  maxDepth: number;
  /** Maximum tokens the grantee can retrieve */
  tokenCap: number;
  /** When the grant expires */
  expiresAt: Date;
  /** Whether this grant has been revoked */
  revoked: boolean;
  /** Creation timestamp */
  createdAt: Date;
};

export type CreateGrantInput = {
  issuerSessionId: string;
  allowedConversationIds: number[];
  allowedSummaryIds?: string[];
  maxDepth?: number;
  tokenCap?: number;
  /** TTL in milliseconds (default: 5 minutes) */
  ttlMs?: number;
};

export type ValidationResult = {
  valid: boolean;
  reason?: string;
};

export type AuthorizedExpansionOrchestrator = {
  expand(grantId: string, request: ExpansionRequest): Promise<ExpansionResult>;
};

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_TOKEN_CAP = 4000;
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── ExpansionAuthManager ─────────────────────────────────────────────────────

export class ExpansionAuthManager {
  private grants: Map<string, ExpansionGrant> = new Map();

  /**
   * Create a new expansion grant with the given parameters.
   * Generates a unique grant ID and applies defaults for optional fields.
   */
  createGrant(input: CreateGrantInput): ExpansionGrant {
    const grantId = "grant_" + crypto.randomUUID().slice(0, 12);
    const now = new Date();
    const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;

    const grant: ExpansionGrant = {
      grantId,
      issuerSessionId: input.issuerSessionId,
      allowedConversationIds: input.allowedConversationIds,
      allowedSummaryIds: input.allowedSummaryIds ?? [],
      maxDepth: input.maxDepth ?? DEFAULT_MAX_DEPTH,
      tokenCap: input.tokenCap ?? DEFAULT_TOKEN_CAP,
      expiresAt: new Date(now.getTime() + ttlMs),
      revoked: false,
      createdAt: now,
    };

    this.grants.set(grantId, grant);
    return grant;
  }

  /**
   * Retrieve a grant by ID. Returns null if the grant does not exist,
   * has been revoked, or has expired.
   */
  getGrant(grantId: string): ExpansionGrant | null {
    const grant = this.grants.get(grantId);
    if (!grant) return null;
    if (grant.revoked) return null;
    if (grant.expiresAt.getTime() <= Date.now()) return null;
    return grant;
  }

  /**
   * Revoke a grant, preventing any further use.
   * Returns true if the grant was found and revoked, false if not found.
   */
  revokeGrant(grantId: string): boolean {
    const grant = this.grants.get(grantId);
    if (!grant) return false;
    grant.revoked = true;
    return true;
  }

  /**
   * Validate an expansion request against a grant.
   * Checks existence, expiry, revocation, conversation scope, summary scope,
   * depth limit, and token cap.
   */
  validateExpansion(
    grantId: string,
    request: {
      conversationId: number;
      summaryIds: string[];
      depth: number;
      tokenCap: number;
    },
  ): ValidationResult {
    const grant = this.grants.get(grantId);

    // 1. Grant must exist
    if (!grant) {
      return { valid: false, reason: "Grant not found" };
    }

    // 2. Grant must not be revoked
    if (grant.revoked) {
      return { valid: false, reason: "Grant has been revoked" };
    }

    // 3. Grant must not be expired
    if (grant.expiresAt.getTime() <= Date.now()) {
      return { valid: false, reason: "Grant has expired" };
    }

    // 4. Conversation ID must be in the allowed set
    if (!grant.allowedConversationIds.includes(request.conversationId)) {
      return {
        valid: false,
        reason: `Conversation ${request.conversationId} is not in the allowed set`,
      };
    }

    // 5. If allowedSummaryIds is non-empty, all requested summaryIds must be allowed
    if (grant.allowedSummaryIds.length > 0) {
      const allowedSet = new Set(grant.allowedSummaryIds);
      const unauthorized = request.summaryIds.filter((id) => !allowedSet.has(id));
      if (unauthorized.length > 0) {
        return {
          valid: false,
          reason: `Summary IDs not authorized: ${unauthorized.join(", ")}`,
        };
      }
    }

    // 6. Depth must not exceed grant's maxDepth
    if (request.depth > grant.maxDepth) {
      return {
        valid: false,
        reason: `Requested depth ${request.depth} exceeds maximum allowed depth ${grant.maxDepth}`,
      };
    }

    // 7. Token cap must not exceed grant's tokenCap
    if (request.tokenCap > grant.tokenCap) {
      return {
        valid: false,
        reason: `Requested token cap ${request.tokenCap} exceeds maximum allowed ${grant.tokenCap}`,
      };
    }

    return { valid: true };
  }

  /**
   * Remove all expired and revoked grants from the store.
   * Returns the number of grants removed.
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [grantId, grant] of this.grants) {
      if (grant.revoked || grant.expiresAt.getTime() <= now) {
        this.grants.delete(grantId);
        removed++;
      }
    }

    return removed;
  }
}

// ── Authorized wrapper ───────────────────────────────────────────────────────

/**
 * Create a thin authorization wrapper around an ExpansionOrchestrator.
 * The wrapper validates the grant before delegating to the underlying
 * orchestrator, and clamps the request's tokenCap to the grant's tokenCap.
 */
export function wrapWithAuth(
  orchestrator: ExpansionOrchestrator,
  authManager: ExpansionAuthManager,
): AuthorizedExpansionOrchestrator {
  return {
    async expand(grantId: string, request: ExpansionRequest): Promise<ExpansionResult> {
      const validation = authManager.validateExpansion(grantId, {
        conversationId: request.conversationId,
        summaryIds: request.summaryIds,
        depth: request.maxDepth ?? DEFAULT_MAX_DEPTH,
        tokenCap: request.tokenCap ?? DEFAULT_TOKEN_CAP,
      });

      if (!validation.valid) {
        throw new Error(`Expansion authorization failed: ${validation.reason}`);
      }

      // Clamp tokenCap to the grant's limit
      const grant = authManager.getGrant(grantId)!;
      const clampedRequest: ExpansionRequest = {
        ...request,
        tokenCap: Math.min(request.tokenCap ?? Infinity, grant.tokenCap),
      };

      return orchestrator.expand(clampedRequest);
    },
  };
}
