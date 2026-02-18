# LCM Expand Query Tool

**Status:** Draft v1  
**Date:** 2026-02-18  
**Author:** Buce + Josh  
**Related:** LCM paper (Ehrlich & Blackman, 2026), openclaw-537 (lcm_expand sub-agent restriction)

## Problem Statement

The main agent has `lcm_grep` and `lcm_describe` for memory recall, but these are limited:

- `lcm_grep` finds relevant summary IDs via regex/full-text search
- `lcm_describe` returns the summary content (~800-2000 tokens), but summaries are inherently lossy

When the main agent needs **specific detail** that was compacted away (exact parameter values debated, specific code discussed, precise reasoning behind a decision), the summary isn't enough. The raw messages are underneath in the DAG, but `lcm_expand` is restricted to sub-agents only (openclaw-537) to prevent context flooding.

**Current workaround:** The main agent would need to manually call `sessions_spawn`, craft a task prompt that tells the sub-agent to call `lcm_expand` and then answer a question, wait for the result, and parse the response. This is clunky and error-prone.

**Desired pattern:** A single tool call that accepts a query/prompt and summary scope, internally spawns a sub-agent to expand and process the content, and returns a compact answer directly to the main agent.

## Design

### Tool: `lcm_expand_query`

Available to **all agents** (main and sub-agent sessions). This is not `lcm_expand` — it never puts raw expanded content into the caller's context.

#### Parameters

```typescript
{
  // What to expand — at least one required
  summaryIds?: string[];      // Specific summary IDs to expand
  query?: string;             // Grep query to find summaries first, then expand matches

  // What to extract — required
  prompt: string;             // The question to answer against the expanded content
                              // e.g. "What exact freshTailCount values were discussed and why was 16 chosen?"

  // Optional constraints
  conversationId?: number;    // Scope to specific conversation (default: current session's)
  allConversations?: boolean; // Allow cross-conversation expansion
  maxTokens?: number;         // Max tokens in the returned answer (default: 2000)
}
```

#### Return Value

```typescript
{
  answer: string;             // The sub-agent's focused answer to the prompt
  citedIds: string[];         // Summary/message IDs referenced
  sourceConversationId: number;
  expandedSummaryCount: number;
  totalSourceTokens: number;  // How many tokens were expanded (not returned to caller)
  truncated: boolean;
}
```

### Internal Flow

1. **Resolve scope:** Same conversation scoping as `lcm_describe` — default to current session's conversation, or use explicit `conversationId`/`allConversations`.

2. **Find summaries (if query provided):** Call `retrieval.grep()` to find matching summary IDs, same as `lcm_expand`'s query mode.

3. **Spawn sub-agent:** Using the existing proven pattern from `lcm-expand-tool.delegation.ts`:

   ```typescript
   // Create child session + expansion grant
   const childSessionKey = `agent:${agentId}:subagent:${crypto.randomUUID()}`;
   createDelegatedExpansionGrant({ ... });

   // Start sub-agent run
   callGateway({ method: "agent", params: { message: task, sessionKey: childSessionKey, deliver: false, lane: AGENT_LANE_SUBAGENT, ... } });

   // Wait for completion
   callGateway({ method: "agent.wait", params: { runId, timeoutMs: ... } });

   // Read result
   readLatestAssistantReply({ sessionKey: childSessionKey });
   ```

4. **Sub-agent task:** The sub-agent receives a structured prompt:

   ```
   You are performing a targeted LCM memory recall task.

   1. Call lcm_expand with this payload:
      { summaryIds: [...], conversationId: N, includeMessages: true }

   2. Using the expanded content, answer this question:
      "<user's prompt>"

   3. Return ONLY a JSON response:
      {
        "answer": "your focused answer here",
        "citedIds": ["sum_xxx", ...],
        "totalTokens": N,
        "truncated": false
      }

   Rules:
   - Keep your answer concise and directly responsive to the question
   - Max answer length: ~<maxTokens> tokens
   - Include specific details (exact values, quotes, code snippets) when relevant
   - Cite the summary IDs that contained the answer
   ```

5. **Parse and return:** Extract the JSON answer from the sub-agent's reply (reuse `parseDelegatedExpansionReply` pattern with an `answer` field), clean up the session and grant.

6. **Cleanup:** Always delete the child session and revoke the expansion grant in a `finally` block.

### Key Differences from `lcm_expand`

| Aspect         | `lcm_expand`                | `lcm_expand_query`                    |
| -------------- | --------------------------- | ------------------------------------- |
| Available to   | Sub-agents only             | All agents                            |
| Returns        | Raw expanded DAG content    | Focused answer to a prompt            |
| Context impact | Can be large (token-capped) | Always compact (~maxTokens)           |
| Use case       | Sub-agent doing deep recall | Main agent asking a specific question |
| Delegation     | May delegate further        | Always delegates (single pass)        |

### Escalation Pattern

The main agent's recall chain becomes:

```
lcm_grep → find summary IDs
    ↓
lcm_describe → read summary content
    ↓ (if summary isn't detailed enough)
lcm_expand_query(summaryIds, prompt) → get specific answer from expanded content
```

## Implementation

### Files to Create/Modify

- **New:** `src/agents/tools/lcm-expand-query-tool.ts` — The tool implementation
- **New:** `src/agents/tools/lcm-expand-query-tool.test.ts` — Unit tests
- **Modify:** Tool registration (wherever lcm tools are registered) — Add `lcm_expand_query`
- **Modify:** System prompt tool descriptions — Add `lcm_expand_query` to the agent's tool catalog

### Reusable Infrastructure

Almost everything needed already exists in the codebase:

- `callGateway({ method: "agent" })` — spawn sub-agent run (from `lcm-expand-tool.delegation.ts`)
- `callGateway({ method: "agent.wait" })` — wait for completion (same file)
- `readLatestAssistantReply()` — read sub-agent output (from `agent-step.ts`)
- `createDelegatedExpansionGrant()` / `revokeDelegatedExpansionGrantForSession()` — auth scoping (from `expansion-auth.ts`)
- `buildSubagentSystemPrompt()` — system prompt construction (from `subagent-announce.ts`)
- `resolveLcmConversationScope()` — conversation scoping (from `lcm-conversation-scope.ts`)
- Response parsing pattern — from `parseDelegatedExpansionReply()` in delegation.ts

### What's Actually New

The tool itself is mostly **orchestration glue** connecting existing pieces:

1. A new tool schema with a `prompt` parameter
2. A task template that includes the user's prompt in the sub-agent's instructions
3. Response parsing that extracts `answer` instead of `summary`

### Timeout

Default sub-agent timeout: 120 seconds (expansion + LLM processing).
Configurable via LCM config if needed.

## Open Questions

1. **Should `lcm_expand_query` support follow-up passes?** The delegation loop in `lcm_expand` supports multi-pass where the sub-agent can request expanding additional summaries. For the query tool, a single pass is probably sufficient — the prompt focuses the answer, and if the agent needs more, it can call the tool again with different summary IDs.

2. **Model selection for the sub-agent:** Should it use the same model as the main agent, or a cheaper/faster model? The answer extraction task is simpler than general conversation, so a faster model might be appropriate. Suggest: inherit from `subagents.model` config, same as `sessions_spawn`.

3. **Should the tool be named differently?** Alternatives: `lcm_recall`, `lcm_query`, `lcm_ask`. The `lcm_expand_query` name makes the relationship to `lcm_expand` clear, but `lcm_recall` might be more intuitive for the agent to decide when to use it.
