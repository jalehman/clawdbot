# LCM Large File Handling — Implementation Spec

**Status:** Draft  
**Date:** 2026-02-17  
**Related:** `specs/lcm-implementation-spec.md`, `specs/lcm-system-overview.md`  
**Branch:** `josh/lcm`

## Problem

When a user sends a large file (PDF, code file, log, etc.) through any surface (Telegram, API), the file's extracted text is injected directly into the user message as a `<file>` block. This goes straight into model context with no interception.

A 40KB PDF = ~10k tokens. A 200KB code file = ~50k tokens. This can blow past the soft compaction threshold in a single message, trigger emergency compaction loops, or simply consume the entire context budget — exactly what happened when reading the LCM paper PDF.

## Design

All interception happens inside the LCM plugin at **ingest time**. No changes to the gateway HTTP layer, Telegram bot, or media-understanding pipeline. Those layers continue to extract file content normally. LCM intercepts the extracted content during `ingestSingle()` before it's persisted.

### Architecture

```
Telegram/API → media-understanding → extractFileContent → <file> blocks in message
                                                              │
                                          ┌───────────────────┘
                                          ▼
                                  LcmContextEngine.ingestSingle()
                                          │
                                     detect <file> blocks
                                          │
                                  ┌───────┴───────┐
                                  │               │
                              small file      large file (>threshold)
                                  │               │
                              pass through    ┌───┴───┐
                                              │       │
                                          store file   generate exploration
                                          on disk      summary (LLM call)
                                              │       │
                                              └───┬───┘
                                                  │
                                          rewrite message content:
                                          replace <file> block with
                                          compact [LCM File: file_xxx] ref
```

### Token Threshold

**Default: 25,000 tokens** (~100KB of text).

Matches the paper's recommendation (Section 2.2). Files under this threshold are small enough to live in context without causing compaction pressure. Files above it are the ones that cause blowups — a single PDF or log dump shouldn't be able to consume 20%+ of the context budget.

Config: `LCM_LARGE_FILE_TOKEN_THRESHOLD` env var. Added to `LcmConfig`:

```typescript
// db/config.ts
export type LcmConfig = {
  // ... existing fields ...
  largeFileTokenThreshold: number; // default 25000
};
```

### Detection: `<file>` Block Extraction

The file content enters the message in a well-defined XML-like format from both surfaces:

**Telegram/media-understanding path:**

```
<file name="paper.pdf" mime="application/pdf">
...extracted text...
</file>
```

**OpenResponses API path:**

```
<file name="paper.pdf">
...extracted text...
</file>
```

Detection regex:

```typescript
const FILE_BLOCK_RE = /<file\s+([^>]*)>([\s\S]*?)<\/file>/g;
```

Parse attributes from the opening tag to extract `name` and optional `mime`.

### Storage

When a file exceeds the token threshold:

1. **Generate a file ID:** `file_${randomUUID().replace(/-/g, '').slice(0, 16)}`

2. **Write file content to disk:**
   - Path: `~/.openclaw/lcm-files/<conversation_id>/<file_id>.<ext>`
   - Extension derived from filename or mime type
   - The `storage_uri` in the DB is this absolute path

3. **Generate exploration summary** (see below)

4. **Insert into `large_files` table** via existing `summaryStore.insertLargeFile()`

5. **Rewrite the message content:** Replace the `<file>` block with a compact reference:

   ```
   [LCM File: file_abc123def456 | paper.pdf | application/pdf | 42,150 bytes]

   Exploration Summary:
   <exploration summary text here>
   ```

   This reference is what gets stored in `messages.content` and what the assembler will see. Total: ~200-400 tokens instead of 10,000+.

### Exploration Summary Generation

The exploration summary is a type-aware compact description of the file content. Three strategies based on mime type:

#### Strategy 1: Structured Data (JSON, CSV, YAML, XML)

**Deterministic — no LLM call.**

Extract schema/structure information:

- JSON: top-level keys, array lengths, nested structure depth
- CSV: column headers, row count, sample values
- YAML: top-level keys, structure
- XML: root element, child element names, attribute names

Target: 200-400 tokens.

```typescript
function exploreStructured(content: string, mimeType: string): string {
  // deterministic extraction, no LLM needed
}
```

#### Strategy 2: Code Files (`.ts`, `.py`, `.rs`, `.go`, etc.)

**Deterministic — no LLM call.**

Extract structural outline:

- Imports/dependencies (first 10 lines or so)
- Exported functions/classes with signatures (no bodies)
- Line count, rough structure

Target: 300-500 tokens.

```typescript
function exploreCode(content: string, fileName: string): string {
  // parse exports, function signatures, class names
}
```

#### Strategy 3: Unstructured Text (PDF, Markdown, plain text, logs)

**LLM call required.**

Use the session's configured model to generate a summary:

```typescript
async function exploreText(content: string, fileName: string): Promise<string> {
  // Single LLM call with a focused prompt:
  // "Summarize this document in 200-300 words. Include:
  //  - What the document is about
  //  - Key sections/topics covered
  //  - Important names, dates, numbers
  //  - Document structure (chapters, sections, etc.)
  //  Do not reproduce the document content verbatim."
}
```

The LLM call uses a **separate, cheap model call** — not the main conversation model. Use whatever lightweight summarization is available. If no LLM is available, fall back to deterministic extraction:

- First 500 chars + last 500 chars
- Section headers (lines starting with `#`, all-caps lines, etc.)
- Word/line/char counts

Target: 200-400 tokens.

### Implementation: Changes to `engine.ts`

The core change is in `ingestSingle()`. After `toStoredMessage(message)` produces the stored content, but before `createMessage()` persists it, we check for large file blocks:

```typescript
private async ingestSingle(params: {
  sessionId: string;
  message: AgentMessage;
  isHeartbeat?: boolean;
}): Promise<IngestResult> {
  const { sessionId, message, isHeartbeat } = params;
  if (isHeartbeat) {
    return { ingested: false };
  }
  const stored = toStoredMessage(message);

  const conversation = await this.conversationStore.getOrCreateConversation(sessionId);
  const conversationId = conversation.conversationId;

  // ── Large file interception ────────────────────────────────────
  const intercepted = await this.interceptLargeFiles({
    conversationId,
    content: stored.content,
    rawMessage: message,
  });
  if (intercepted) {
    stored.content = intercepted.rewrittenContent;
    stored.tokenCount = estimateTokens(intercepted.rewrittenContent);
  }
  // ───────────────────────────────────────────────────────────────

  const maxSeq = await this.conversationStore.getMaxSeq(conversationId);
  const seq = maxSeq + 1;

  const msgRecord = await this.conversationStore.createMessage({
    conversationId,
    seq,
    role: stored.role,
    content: stored.content,
    tokenCount: stored.tokenCount,
  });
  // ... rest unchanged
}
```

The `interceptLargeFiles` method:

```typescript
private async interceptLargeFiles(params: {
  conversationId: number;
  content: string;
  rawMessage: AgentMessage;
}): Promise<{ rewrittenContent: string; fileIds: string[] } | null> {
  const { conversationId, content } = params;
  const threshold = this.config.largeFileTokenThreshold;

  // Find all <file> blocks
  const blocks = parseFileBlocks(content);
  if (blocks.length === 0) return null;

  let anyIntercepted = false;
  let rewritten = content;
  const fileIds: string[] = [];

  for (const block of blocks) {
    const tokens = estimateTokens(block.text);
    if (tokens < threshold) continue;

    anyIntercepted = true;

    // Generate file ID and store content on disk
    const fileId = `file_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const ext = extensionFromNameOrMime(block.fileName, block.mimeType);
    const storagePath = await this.storeFileContent({
      conversationId,
      fileId,
      ext,
      content: block.text,
    });

    // Generate exploration summary
    const summary = await this.generateExplorationSummary({
      content: block.text,
      fileName: block.fileName,
      mimeType: block.mimeType,
    });

    // Persist to large_files table
    await this.summaryStore.insertLargeFile({
      fileId,
      conversationId,
      fileName: block.fileName,
      mimeType: block.mimeType,
      byteSize: Buffer.byteLength(block.text, 'utf8'),
      storageUri: storagePath,
      explorationSummary: summary,
    });

    // Replace the <file> block in the message content
    const reference = formatFileReference({ fileId, fileName: block.fileName, mimeType: block.mimeType, byteSize: block.text.length, summary });
    rewritten = rewritten.replace(block.fullMatch, reference);
    fileIds.push(fileId);
  }

  return anyIntercepted ? { rewrittenContent: rewritten, fileIds } : null;
}
```

### File Reference Format

The compact reference replaces the full `<file>` block:

```
[LCM File: file_abc123def456 | paper.pdf | application/pdf | 42,150 bytes]

Exploration Summary:
This is a research paper titled "Lossless Context Management" by Ehrlich & Blackman (February 2026).
It presents an architecture for maintaining full conversation history in AI assistant systems through
hierarchical summarization into a DAG structure. Key topics: dual-state memory (Immutable Store +
Active Context), soft/hard compaction thresholds, three-level summarization escalation, large file
handling via exploration summaries, and sub-agent expansion patterns. The paper includes formal
proofs of convergence guarantees and benchmarks showing zero-cost continuity below soft threshold.
```

This is ~120 tokens vs the original ~10,000+ tokens for a large file. The `file_abc123def456` ID is discoverable via `lcm_describe` which already handles `file_` prefixed IDs.

### File Content Storage

```
~/.openclaw/lcm-files/
  <conversation_id>/
    <file_id>.<ext>
```

Simple filesystem storage. The `storage_uri` in the DB is the absolute path. Files are write-once, never modified. Cleanup can follow conversation lifecycle (future work).

```typescript
private async storeFileContent(params: {
  conversationId: number;
  fileId: string;
  ext: string;
  content: string;
}): Promise<string> {
  const dir = join(homedir(), '.openclaw', 'lcm-files', String(params.conversationId));
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `${params.fileId}.${params.ext}`);
  await writeFile(filePath, params.content, 'utf8');
  return filePath;
}
```

### Propagation Through Compaction

When messages containing file references get compacted into summaries, the compaction prompt should preserve file IDs. The existing `file_ids` column on the `summaries` table is designed for this — the compaction engine should extract any `file_xxx` IDs from the source messages and attach them to the resulting summary.

This is a small addition to the compaction flow:

```typescript
// In compaction, after generating a summary from source messages:
const fileIds = extractFileIdsFromContent(sourceMessages);
// Store on the summary record
summary.fileIds = fileIds;
```

Extraction regex: `/file_[a-f0-9]{16}/g`

### Message Parts

When `buildMessageParts()` processes a message that was rewritten by large file interception, the parts will contain the compact reference (not the original file content). This is correct — the parts should mirror what was actually stored.

The original file content lives on disk at `storage_uri` and is accessible via `lcm_describe(file_id)`.

## Config Changes

```typescript
// db/config.ts additions
export type LcmConfig = {
  // ... existing ...
  largeFileTokenThreshold: number;
};

export function resolveLcmConfig(env = process.env): LcmConfig {
  return {
    // ... existing ...
    largeFileTokenThreshold: parseInt(env.LCM_LARGE_FILE_TOKEN_THRESHOLD ?? "25000", 10),
  };
}
```

## What This Does NOT Change

- **Gateway HTTP layer** — `openresponses-http.ts` continues extracting file content normally
- **Telegram bot** — media-understanding continues producing `<file>` blocks normally
- **Assembler** — reads from stored messages/summaries which already contain the compact reference
- **lcm_describe** — already handles `file_` IDs, returns exploration summary
- **lcm_grep** — searches over stored message content, which now has compact refs (grep for the file name or summary text still works)

## Edge Cases

1. **Multiple files in one message:** Each `<file>` block is evaluated independently. Some may be small (pass through), others large (intercepted).

2. **File below threshold:** Left as-is in the message content. No interception.

3. **No LLM available for exploration summary:** Fall back to deterministic summary (first/last 500 chars + headers + stats).

4. **Image-only PDFs (scanned):** The `<file>` block will contain `[PDF content rendered to images]` with no substantial text. This won't hit the token threshold, so no interception needed. The images go through the normal image pipeline.

5. **Same file sent twice:** Each gets its own `file_id` and storage. Deduplication is future work (could hash content).

6. **File content in system prompt (OpenResponses API path):** The API path puts file content into `extraSystemPrompt`, not the user message. The LCM ingest only sees the user message. For v1, this means API-path files aren't intercepted. This is acceptable because the API path already has `maxChars` limits and the system prompt isn't persisted by LCM.

## New Files

- `src/plugins/lcm/large-files.ts` — `parseFileBlocks()`, `formatFileReference()`, `extensionFromNameOrMime()`, `generateExplorationSummary()` (deterministic strategies), `exploreStructuredData()`, `exploreCode()`

## Modified Files

- `src/plugins/lcm/engine.ts` — `interceptLargeFiles()` method, call site in `ingestSingle()`
- `src/plugins/lcm/db/config.ts` — `largeFileTokenThreshold` field
- `src/plugins/lcm/compaction.ts` — extract file IDs from source messages, attach to summary

## Testing

1. **Unit test: `parseFileBlocks()`** — correctly parses `<file>` blocks with various attribute formats
2. **Unit test: `interceptLargeFiles()`** — replaces large blocks, leaves small ones
3. **Unit test: exploration summary generators** — structured, code, text strategies
4. **Integration test: ingest → assemble round-trip** — large file is intercepted at ingest, assembled context contains compact reference, `lcm_describe` returns the file
5. **Integration test: compaction preserves file IDs** — file references survive compaction into summaries

## Implementation Order

1. `large-files.ts` — parsing and formatting utilities
2. `engine.ts` — `interceptLargeFiles()` + call site in `ingestSingle()`
3. `config.ts` — threshold config
4. `compaction.ts` — file ID propagation through summaries
5. Tests
