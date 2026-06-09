/**
 * Shared session persistence and prompt-body helpers for agent attempt
 * execution paths.
 */
import { patchSessionEntryWithRowOptions } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  formatAgentInternalEventsForPlainPrompt,
  formatAgentInternalEventsForPrompt,
} from "../internal-events.js";
import {
  hasInternalRuntimeContext,
  stripInternalRuntimeContext,
} from "../internal-runtime-context.js";
import type { AgentCommandOpts } from "./types.js";

/** Parameters for merging and persisting a session entry update. */
export type PersistSessionEntryParams = {
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath: string;
  entry: SessionEntry;
  clearedFields?: string[];
  preserveTranscriptMarkerUpdatedAt?: boolean;
  shouldPersist?: (entry: SessionEntry | undefined) => boolean;
};

/** Persists one session entry while keeping the caller's in-memory store aligned. */
export async function persistSessionEntry(
  params: PersistSessionEntryParams,
): Promise<SessionEntry | undefined> {
  const persisted = await patchSessionEntryWithRowOptions({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    fallbackEntry: params.entry,
    deleteFields: params.clearedFields,
    preservePatchActivity: params.preserveTranscriptMarkerUpdatedAt,
    shouldPersist: params.shouldPersist,
    update: () => params.entry,
  });
  if (persisted) {
    params.sessionStore[params.sessionKey] = persisted;
  } else {
    delete params.sessionStore[params.sessionKey];
  }
  return persisted ?? undefined;
}

/** Prepends hidden internal event context unless the body already carries it. */
export function prependInternalEventContext(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  if (hasInternalRuntimeContext(body)) {
    return body;
  }
  const renderedEvents = formatAgentInternalEventsForPrompt(events);
  if (!renderedEvents) {
    return body;
  }
  return [renderedEvents, body].filter(Boolean).join("\n\n");
}

// ACP/plain transcript bodies cannot carry internal runtime context markup, so
// render events as visible plain text before stripping hidden sections.
function resolvePlainInternalEventBody(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  const renderedEvents = formatAgentInternalEventsForPlainPrompt(events);
  if (!renderedEvents) {
    return body;
  }
  const visibleBody = stripInternalRuntimeContext(body).trim();
  return [renderedEvents, visibleBody].filter(Boolean).join("\n\n") || body;
}

/** Resolves the prompt body submitted to ACP runtimes. */
export function resolveAcpPromptBody(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  return events?.length ? resolvePlainInternalEventBody(body, events) : body;
}

/** Resolves the body stored in transcripts after internal event rendering. */
export function resolveInternalEventTranscriptBody(
  body: string,
  events: AgentCommandOpts["internalEvents"],
): string {
  if (!hasInternalRuntimeContext(body)) {
    return body;
  }
  return resolvePlainInternalEventBody(body, events);
}
