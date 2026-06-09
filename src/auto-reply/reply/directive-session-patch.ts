// Shared directive patch field lists for row-scoped session persistence.
import type { SessionEntry } from "../../config/sessions.js";

export const MODEL_OVERRIDE_SESSION_PATCH_FIELDS = [
  "providerOverride",
  "modelOverride",
  "modelOverrideSource",
  "modelOverrideFallbackOriginProvider",
  "modelOverrideFallbackOriginModel",
  "model",
  "modelProvider",
  "contextTokens",
  "contextBudgetStatus",
  "authProfileOverride",
  "authProfileOverrideSource",
  "authProfileOverrideCompactionCount",
  "liveModelSwitchPending",
  "fallbackNoticeSelectedModel",
  "fallbackNoticeActiveModel",
  "fallbackNoticeReason",
] as const satisfies ReadonlyArray<keyof SessionEntry>;

export const QUEUE_SESSION_PATCH_FIELDS = [
  "queueMode",
  "queueDebounceMs",
  "queueCap",
  "queueDrop",
] as const satisfies ReadonlyArray<keyof SessionEntry>;

export function copySessionEntryPatchFields(
  patch: Partial<SessionEntry>,
  entry: SessionEntry,
  fields: ReadonlyArray<keyof SessionEntry>,
): void {
  for (const field of fields) {
    patch[field] = entry[field] as never;
  }
}
