import type { LcmMessage } from "./types.js";

/**
 * Shared token-estimation contract for LCM components.
 */
export type TokenEstimator = {
  estimateText(text: string): number;
  estimateMessage(message: Pick<LcmMessage, "content">): number;
  estimateMessages(messages: Array<Pick<LcmMessage, "content">>): number;
};

/**
 * Placeholder token estimator used until provider/model-specific estimators
 * are implemented. Uses a conservative chars/4 heuristic.
 */
export class PlaceholderTokenEstimator implements TokenEstimator {
  estimateText(text: string): number {
    const normalized = text.trim();
    if (!normalized) {
      return 0;
    }
    return Math.ceil(normalized.length / 4);
  }

  estimateMessage(message: Pick<LcmMessage, "content">): number {
    return this.estimateText(message.content);
  }

  estimateMessages(messages: Array<Pick<LcmMessage, "content">>): number {
    let total = 0;
    for (const message of messages) {
      total += this.estimateMessage(message);
    }
    return total;
  }
}

/**
 * Create the default placeholder estimator instance.
 */
export function createPlaceholderTokenEstimator(): TokenEstimator {
  return new PlaceholderTokenEstimator();
}
