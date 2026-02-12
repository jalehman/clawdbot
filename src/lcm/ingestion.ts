import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createHash } from "node:crypto";
import type { TokenEstimator } from "./token-estimator.js";
import type {
  ConversationId,
  ConversationStore,
  LcmMessagePartKind,
  MessageId,
  MessageRole,
  StoredLcmMessagePart,
} from "./types.js";
import { buildConversationScopedItemId } from "./conversation-store.js";

export type IngestCanonicalTranscriptParams = {
  store: ConversationStore;
  tokenEstimator: TokenEstimator;
  conversationId: ConversationId;
  sessionId: string;
  channel?: string;
  provider: string;
  modelId: string;
  messages: AgentMessage[];
  baseNowMs?: number;
};

export type IngestCanonicalTranscriptResult = {
  conversationId: ConversationId;
  persistedMessageIds: MessageId[];
  messageCount: number;
};

/**
 * Persist a transcript in canonical, append-first storage form.
 */
export async function ingestCanonicalTranscript(
  params: IngestCanonicalTranscriptParams,
): Promise<IngestCanonicalTranscriptResult> {
  const persistedMessageIds: MessageId[] = [];
  const baseNowMs = params.baseNowMs ?? Date.now();
  for (let index = 0; index < params.messages.length; index += 1) {
    const message = params.messages[index];
    const normalized = normalizeMessage({
      message,
      index,
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      provider: params.provider,
      modelId: params.modelId,
      tokenEstimator: params.tokenEstimator,
      createdAtMs: readMessageTimestamp(message) ?? baseNowMs + index,
    });

    const persisted = await params.store.createMessage({
      messageId: normalized.messageId,
      conversationId: params.conversationId,
      sessionId: params.sessionId,
      channel: params.channel,
      ordinal: index,
      role: normalized.role,
      authorId: normalized.authorId,
      contentText: normalized.contentText,
      payload: normalized.payload,
      createdAtMs: normalized.createdAtMs,
    });
    persistedMessageIds.push(persisted.messageId);

    await params.store.createMessageParts({
      messageId: persisted.messageId,
      parts: normalized.parts,
    });

    await params.store.appendContextMessage({
      itemId: buildConversationScopedItemId(
        "ctxmsg",
        params.conversationId,
        String(persisted.messageId),
      ),
      conversationId: params.conversationId,
      messageId: persisted.messageId,
      depth: 0,
      title: `${normalized.role}:${index + 1}`,
      body: normalized.contentText,
      metadata: {
        role: normalized.role,
        ordinal: index,
      },
      createdAtMs: normalized.createdAtMs,
    });
  }

  return {
    conversationId: params.conversationId,
    persistedMessageIds,
    messageCount: persistedMessageIds.length,
  };
}

/**
 * Resolve a canonical conversation id, defaulting to the session id.
 */
export function resolveConversationId(
  sessionId: string,
  meta?: Record<string, unknown>,
): ConversationId {
  const fromMeta = meta?.conversationId;
  if (typeof fromMeta === "string" && fromMeta.trim()) {
    return fromMeta.trim() as ConversationId;
  }
  return sessionId.trim() as ConversationId;
}

type NormalizedMessage = {
  messageId: MessageId;
  role: MessageRole;
  authorId?: string;
  contentText: string;
  payload: Record<string, unknown>;
  parts: StoredLcmMessagePart[];
  createdAtMs: number;
};

function normalizeMessage(params: {
  message: AgentMessage;
  index: number;
  conversationId: ConversationId;
  sessionId: string;
  provider: string;
  modelId: string;
  tokenEstimator: TokenEstimator;
  createdAtMs: number;
}): NormalizedMessage {
  const role = normalizeMessageRole(readRole(params.message));
  const messageId = buildMessageId(params.conversationId, params.index);
  const parts = buildMessageParts({
    messageId,
    message: params.message,
    createdAtMs: params.createdAtMs,
    tokenEstimator: params.tokenEstimator,
  });
  const contentText = summarizeTextContent(params.message, parts);
  return {
    messageId,
    role,
    authorId: readAuthorId(params.message),
    contentText,
    payload: {
      sessionId: params.sessionId,
      provider: params.provider,
      modelId: params.modelId,
      raw: toRecord(params.message),
    },
    parts,
    createdAtMs: params.createdAtMs,
  };
}

function buildMessageId(conversationId: ConversationId, ordinal: number): MessageId {
  return `msg_${digestHex(`${conversationId}:${ordinal}`).slice(0, 24)}` as MessageId;
}

function buildMessageParts(params: {
  messageId: MessageId;
  message: AgentMessage;
  createdAtMs: number;
  tokenEstimator: TokenEstimator;
}): StoredLcmMessagePart[] {
  const content = (params.message as { content?: unknown }).content;
  if (typeof content === "string") {
    return [
      {
        partId: buildPartId(params.messageId, 0, "text"),
        messageId: params.messageId,
        partIndex: 0,
        kind: "text",
        textContent: content,
        tokenCount: params.tokenEstimator.estimateText(content),
        payload: { text: content },
        createdAtMs: params.createdAtMs,
      },
    ];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const parts: StoredLcmMessagePart[] = [];
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    const blockRecord = toRecord(block);
    const kind = detectPartKind(blockRecord);
    const textContent = readTextContent(blockRecord);
    const payload = Object.keys(blockRecord).length > 0 ? blockRecord : { value: block };
    const tokenCount = textContent ? params.tokenEstimator.estimateText(textContent) : undefined;
    const mimeType =
      readStringField(blockRecord, "mimeType") ?? readStringField(blockRecord, "mime");
    const blobPath =
      readStringField(blockRecord, "path") ?? readStringField(blockRecord, "filePath");
    parts.push({
      partId: buildPartId(params.messageId, index, kind),
      messageId: params.messageId,
      partIndex: index,
      kind,
      mimeType: mimeType || undefined,
      textContent: textContent || undefined,
      blobPath: blobPath || undefined,
      tokenCount,
      payload,
      createdAtMs: params.createdAtMs,
    });
  }
  return parts;
}

function summarizeTextContent(message: AgentMessage, parts: StoredLcmMessagePart[]): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  const textSegments = parts
    .map((part) => part.textContent?.trim())
    .filter((value): value is string => Boolean(value));
  if (textSegments.length > 0) {
    return textSegments.join("\n");
  }
  if (Array.isArray(content)) {
    const fallback = stringifyUnknown(content).trim();
    if (fallback) {
      return fallback;
    }
  }
  return "";
}

function buildPartId(messageId: MessageId, partIndex: number, kind: LcmMessagePartKind): string {
  return `part_${digestHex(`${messageId}:${partIndex}:${kind}`).slice(0, 24)}`;
}

function detectPartKind(block: Record<string, unknown>): LcmMessagePartKind {
  const type = readStringField(block, "type");
  if (!type) {
    return "other";
  }
  if (type === "text") {
    return "text";
  }
  if (type === "image") {
    return "image";
  }
  if (type === "toolCall" || type === "toolUse" || type === "functionCall") {
    return "toolCall";
  }
  if (type === "toolResult") {
    return "toolResult";
  }
  if (type === "thinking") {
    return "thinking";
  }
  if (type === "json") {
    return "json";
  }
  return "other";
}

function readTextContent(block: Record<string, unknown>): string {
  const textCandidate =
    readStringField(block, "text") ??
    readStringField(block, "content") ??
    readStringField(block, "value");
  if (textCandidate) {
    return textCandidate;
  }
  const input =
    block.input ?? block.arguments ?? block.result ?? block.output ?? block.data ?? block.value;
  if (input === undefined || input === null) {
    return "";
  }
  return stringifyUnknown(input);
}

function normalizeMessageRole(rawRole: string): MessageRole {
  if (rawRole === "system" || rawRole === "user" || rawRole === "assistant") {
    return rawRole;
  }
  if (rawRole === "tool" || rawRole === "toolResult") {
    return "tool";
  }
  return "assistant";
}

function readRole(message: AgentMessage): string {
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : "assistant";
}

function readAuthorId(message: AgentMessage): string | undefined {
  const record = toRecord(message);
  const candidate =
    readStringField(record, "authorId") ??
    readStringField(record, "senderId") ??
    readStringField(record, "userId");
  return candidate || undefined;
}

function readMessageTimestamp(message: AgentMessage): number | null {
  const raw = (message as { timestamp?: unknown; createdAt?: unknown }).timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }
  const createdAt = (message as { createdAt?: unknown }).createdAt;
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) {
    return Math.trunc(createdAt);
  }
  return null;
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function digestHex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
