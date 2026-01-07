/**
 * OpenAI-compatible API types for the chat completions endpoint.
 *
 * These types follow the OpenAI Chat Completions API specification to ensure
 * compatibility with any OpenAI-compatible client (ElevenLabs, LangChain, etc.).
 */

// Request types
export type OpenAIChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  name?: string;
};

export type OpenAIChatCompletionRequest = {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  user?: string;
  // Additional fields that may be passed but are ignored
  top_p?: number;
  n?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
};

// Response types for streaming (SSE)
export type OpenAIChatCompletionChunkChoice = {
  index: number;
  delta: {
    role?: "assistant";
    content?: string;
  };
  finish_reason: "stop" | "length" | null;
};

export type OpenAIChatCompletionChunk = {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIChatCompletionChunkChoice[];
};

// Response types for non-streaming
export type OpenAIChatCompletionChoice = {
  index: number;
  message: {
    role: "assistant";
    content: string;
  };
  finish_reason: "stop" | "length";
};

export type OpenAIChatCompletionUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type OpenAIChatCompletion = {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAIChatCompletionChoice[];
  usage: OpenAIChatCompletionUsage;
};

// Error response type
export type OpenAIErrorResponse = {
  error: {
    message: string;
    type: "invalid_request_error" | "authentication_error" | "server_error";
    code:
      | "invalid_api_key"
      | "invalid_request"
      | "model_not_found"
      | "server_error";
  };
};
