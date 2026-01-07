# Voice UX Research: Tool Call Acknowledgments

## Problem Statement

When using voice mode via ElevenLabs Conversational AI, if a question requires tool calls (checking calendar, searching, etc.), the agent goes silent while doing the work. This causes:
- ElevenLabs timeout waiting for response
- Unnatural UX (long silence)
- User confusion about whether the request was heard

## Desired Behavior

In voice mode, the agent should:
1. Acknowledge the request conversationally FIRST ("Let me check that for you...")
2. THEN do the tool calls
3. Respond with the results

## Research Findings

### ElevenLabs "Buffer Words" Pattern

ElevenLabs [recommends](https://elevenlabs.io/docs/agents-platform/customization/llm/custom-llm) implementing "buffer words" for slow processing:

> If your custom LLM has slow processing times (perhaps due to agentic reasoning or pre-processing requirements) you can improve the conversational flow by implementing buffer words in your streaming responses.

**Key Implementation Detail:**
- Stream an initial response ending with "... " (ellipsis followed by space)
- This allows Text-to-Speech to maintain natural flow
- The extra space is crucial to prevent audio distortions when appending subsequent content

### Current Clawdbot Implementation

**Voice Session Flow (in `src/gateway/openai-compat/`):**
1. `isVoiceSessionHeader()` detects voice mode via `x-clawdbot-voice-session` header
2. Voice sessions fork to a fast model (Haiku) via `getOrCreateVoiceSession()`
3. Sessions use `thinkingLevel: "none"` for speed
4. SSE streaming via `sse-writer.ts` can stream content chunks immediately

**Current Gaps:**
- No voice-specific system prompt injection
- No mechanism to acknowledge before tool calls
- `messagesToClawdbotFormat()` extracts system prompts but they're not used for voice

### Solution Options

#### Option 1: Voice System Prompt Injection (Recommended)

Inject a voice-specific system prompt when `isVoiceMode` is detected:

```
When operating in voice mode:
- ALWAYS acknowledge the user's request with a brief conversational response BEFORE performing any tool calls
- Use phrases like "Let me check that for you...", "One moment while I look that up...", "I'll find that information..."
- Stream the acknowledgment immediately, then proceed with tool calls
- Keep acknowledgments under 10 words
```

**Pros:**
- Minimal code changes (prompt engineering)
- Works with any tool
- No architectural changes needed

**Cons:**
- Relies on model compliance
- May add latency for the acknowledgment generation

#### Option 2: Streaming Acknowledgment Hook

Inject a hardcoded acknowledgment at the SSE level when tool use is detected:

**Pros:**
- Deterministic behavior
- Fastest possible acknowledgment

**Cons:**
- Requires detecting tool calls before they happen
- May feel robotic/repetitive

#### Option 3: First Response Override

Configure ElevenLabs `first_message` and conversation overrides:
- ElevenLabs supports [conversation_config_override](https://elevenlabs.io/docs/conversational-ai/customization/personalization/overrides) for custom system prompts per call
- Dynamic variables via `{{ var_name }}` syntax

**Pros:**
- Native ElevenLabs feature
- Can personalize per conversation

**Cons:**
- Only affects first message, not mid-conversation tool calls

### ElevenLabs Post-Call Webhooks

For voice-to-main session sync, ElevenLabs provides [post-call webhooks](https://elevenlabs.io/docs/agents-platform/workflows/post-call-webhooks):

**Webhook Types:**
- `post_call_transcription`: Full conversation data including transcripts and analysis
- `post_call_audio`: Base64-encoded audio of conversation
- `call_initiation_failure`: Failed call metadata

**Data Included in `post_call_transcription`:**
- `conversation_id`
- `transcript` (list of conversation turns)
- `metadata`
- `analysis` (if configured)
- `status`: initiated | in-progress | processing | done | failed

**Clawdbot Already Has:**
- `/v1/voice/session/end` endpoint (see `voice-session-end.ts`)
- Accepts optional `summary` from webhook
- Supports `compactionSource`: 'self' | 'webhook' | 'auto'

### Timeout Configuration

ElevenLabs [turn timeout](https://elevenlabs.io/docs/agents-platform/customization/conversation-flow) settings:
- Range: 1-30 seconds
- Recommendation: 5-10s for casual conversations, 10-30s for complex responses
- Timeout prompts can be configured in system prompt

### Subagent Pattern for Long-Running Tools

For tools that take >10 seconds, consider:
1. Voice session streams immediate acknowledgment
2. Spawns subagent for long-running work
3. Voice session provides progress updates or offers to notify when complete

This requires coordination between voice session (Haiku) and main session (Opus).

## Recommended Implementation Plan

### Phase 1: Voice System Prompt Injection (Simplest)

1. Add `voiceSystemPrompt` to `OpenAICompatConfig`
2. Inject it when `isVoiceMode` is detected in `index.ts`
3. Default prompt instructs acknowledgment before tool use

### Phase 2: ElevenLabs Webhook Integration

1. Configure ElevenLabs to send `post_call_transcription` to `/v1/voice/session/end`
2. Use transcript data to enrich main session context
3. Already mostly implemented - needs testing

### Phase 3: Streaming Optimization (If Needed)

1. Detect tool call intent in streaming response
2. Inject acknowledgment at SSE level before tool execution
3. More complex, only if prompt engineering insufficient

## References

- [ElevenLabs Custom LLM - Buffer Words](https://elevenlabs.io/docs/agents-platform/customization/llm/custom-llm)
- [ElevenLabs Conversation Flow](https://elevenlabs.io/docs/agents-platform/customization/conversation-flow)
- [ElevenLabs Post-Call Webhooks](https://elevenlabs.io/docs/agents-platform/workflows/post-call-webhooks)
- [ElevenLabs Overrides](https://elevenlabs.io/docs/conversational-ai/customization/personalization/overrides)
- [ElevenLabs Prompting Guide](https://elevenlabs.io/docs/agents-platform/best-practices/prompting-guide)
- [Latency Optimization Blog](https://elevenlabs.io/blog/how-do-you-optimize-latency-for-conversational-ai)
