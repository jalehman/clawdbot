# PRD: Voice Gateway for Clawdbot

## Overview

Enable real-time voice conversations with Clawdbot by exposing an OpenAI-compatible API endpoint that integrates with ElevenLabs Conversational AI.

## Problem Statement

Currently, voice interaction with Clawdbot requires:
1. User records voice message
2. Message transcribed via Whisper
3. Text sent to Clawdbot
4. Response generated
5. TTS generated via `sag`
6. Audio sent back

This async flow has 4-8 second latency per turn and doesn't feel like a natural conversation.

## Proposed Solution

Integrate with ElevenLabs Conversational AI by exposing an OpenAI-compatible `/v1/chat/completions` endpoint from Clawdbot. ElevenLabs handles:
- Real-time voice capture
- Speech-to-text
- Turn-taking and interruption handling
- Text-to-speech with Samantha voice

Clawdbot handles:
- Receiving chat completion requests
- Routing to the user's main session (with full context/memory/tools)
- Streaming responses back in OpenAI format

## User Stories

1. **As Josh**, I want to call a phone number or open a web widget and have a voice conversation with Buce that feels natural and responsive.

2. **As Josh**, I want the voice agent to have full access to my Clawdbot context - memory, calendar, emails, etc. - just like text chat.

3. **As Josh**, I want secure access so only authorized callers (me via ElevenLabs) can reach the endpoint.

## Technical Requirements

### 1. OpenAI-Compatible Endpoint

**Endpoint:** `POST /v1/chat/completions`

**Request format:**
```json
{
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."}
  ],
  "model": "clawdbot",
  "temperature": 0.7,
  "stream": true
}
```

**Response format:** Server-Sent Events (SSE) streaming in OpenAI format:
```
data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"},"index":0}]}

data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"content":" there"},"index":0}]}

data: [DONE]
```

### 2. Session Integration

The endpoint must route messages to the user's **existing main session**, not create isolated conversations. This ensures:
- Full context from SOUL.md, memory files, etc.
- Access to all tools and skills
- Conversation continuity with text chats

**Implementation options:**
- A. Inject into existing session queue
- B. Create a "voice" session type that shares context with main
- C. Use sessions_send internally

### 3. Authentication

**Bearer token authentication:**
- Generate a secure random token (stored in Clawdbot config)
- ElevenLabs stores token in their Secrets feature
- Every request must include `Authorization: Bearer <token>`
- Reject requests without valid token (401)

### 4. Public Endpoint Exposure

Since Clawdbot runs on a local machine without public IP:

**Recommended: Cloudflare Tunnel**
- Free, stable URLs
- Can use custom domain
- Encrypted by default
- Easy setup: `cloudflared tunnel --url http://localhost:<port>`

**Alternative: ngrok**
- Simple but URL rotates (paid for fixed)

**Configuration:**
- Tunnel URL stored in Clawdbot config
- Documented setup steps for users

### 5. ElevenLabs Agent Configuration

Create/configure an ElevenLabs Conversational AI agent with:
- **Voice:** Samantha (custom cloned voice)
- **LLM:** Custom LLM pointing to Clawdbot endpoint
- **First message:** Configurable greeting
- **System prompt:** Can be minimal since Clawdbot has its own

**Access methods:**
- Web widget (embeddable)
- Phone number (via Twilio integration)
- WhatsApp voice (ElevenLabs supports this)

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  User (Voice)   │────▶│   ElevenLabs     │────▶│  Cloudflare     │
│                 │◀────│  Conversational  │◀────│  Tunnel         │
└─────────────────┘     │  AI              │     └────────┬────────┘
                        │  - STT           │              │
                        │  - Turn-taking   │              ▼
                        │  - TTS (Samantha)│     ┌─────────────────┐
                        └──────────────────┘     │   Clawdbot      │
                                                 │   Gateway       │
                                                 │                 │
                                                 │  POST /v1/chat/ │
                                                 │  completions    │
                                                 │       │         │
                                                 │       ▼         │
                                                 │  Main Session   │
                                                 │  (full context) │
                                                 └─────────────────┘
```

## Implementation Phases

### Phase 1: Core Endpoint
- [ ] Add `/v1/chat/completions` route to Gateway
- [ ] Implement OpenAI-format request parsing
- [ ] Implement SSE streaming response
- [ ] Add bearer token authentication
- [ ] Route to main session with context

### Phase 2: Tunnel Integration
- [ ] Document Cloudflare Tunnel setup
- [ ] Add tunnel URL to config schema
- [ ] Create setup script for tunnel
- [ ] Health check endpoint for tunnel validation

### Phase 3: ElevenLabs Integration
- [ ] Create ElevenLabs agent via API or dashboard
- [ ] Configure Samantha voice
- [ ] Configure custom LLM pointing to tunnel
- [ ] Test end-to-end voice flow

### Phase 4: Polish
- [ ] Handle tool calls (if ElevenLabs supports)
- [ ] Conversation history/context window management
- [ ] Rate limiting
- [ ] Logging and monitoring
- [ ] Phone number setup (optional)

## Security Considerations

1. **Token rotation:** Should support rotating the bearer token without downtime
2. **Rate limiting:** Prevent abuse even with valid token
3. **Audit logging:** Log all voice gateway requests
4. **Token storage:** Never log or expose the token in responses

## Success Metrics

1. End-to-end latency < 2 seconds for first response token
2. Voice conversations feel natural (subjective)
3. Full tool/skill access works via voice
4. Zero unauthorized access attempts succeed

## Open Questions

1. Should voice sessions appear in session history?
2. How to handle long-running tool calls (e.g., spawning workers)?
3. Should there be a "voice mode" that adjusts response style (more conversational, shorter)?
4. Multi-user support (different tokens per user)?

## References

- [ElevenLabs Custom LLM Docs](https://elevenlabs.io/docs/agents-platform/customization/llm/custom-llm)
- [Cloudflare Tunnel Docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat/create)
