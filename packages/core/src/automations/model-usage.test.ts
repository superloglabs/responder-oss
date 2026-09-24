import { describe, expect, it } from "vitest";
import { createAutomationModelUsageObserver } from "./model-usage.js";

const encoder = new TextEncoder();

function observe(
  format: "chat_completions" | "messages" | "responses",
  contentType: string,
  chunks: string[],
) {
  const observer = createAutomationModelUsageObserver(format, contentType);
  for (const chunk of chunks) observer.observe(encoder.encode(chunk));
  return observer.finish();
}

describe("automation model usage observer", () => {
  it("reads OpenAI Responses usage from a stream split across chunks", () => {
    const event = JSON.stringify({
      response: {
        usage: {
          input_tokens: 1_200,
          input_tokens_details: { cached_tokens: 1_000 },
          output_tokens: 80,
        },
      },
      type: "response.completed",
    });
    const stream = `event: response.created\ndata: {"type":"response.created"}\n\nevent: response.completed\ndata: ${event}\n\n`;

    expect(observe("responses", "text/event-stream", [
      stream.slice(0, 50),
      stream.slice(50, 120),
      stream.slice(120),
    ])).toEqual({
      cacheWriteTokens: 0,
      cachedInputTokens: 1_000,
      inputTokens: 200,
      outputTokens: 80,
    });
  });

  it("combines Anthropic message start and cumulative delta usage", () => {
    const stream = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20,"cache_creation_input_tokens":300,"cache_read_input_tokens":4000,"output_tokens":1}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":90}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];

    expect(observe("messages", "text/event-stream; charset=utf-8", stream)).toEqual({
      cacheWriteTokens: 300,
      cachedInputTokens: 4_000,
      inputTokens: 20,
      outputTokens: 90,
    });
  });

  it("reads usage from non-streaming JSON responses", () => {
    expect(observe("messages", "application/json", [
      '{"content":[],"usage":{"input_tokens":5,',
      '"output_tokens":7}}',
    ])).toEqual({
      cacheWriteTokens: 0,
      cachedInputTokens: 0,
      inputTokens: 5,
      outputTokens: 7,
    });
  });

  it("returns null when the provider reports no usage", () => {
    expect(observe("responses", "text/event-stream", [
      'data: {"type":"response.output_text.delta"}\n\n',
      "data: not-json\n\n",
    ])).toBeNull();
  });

  it("reads chat completion usage from the final stream chunk", () => {
    expect(observe("chat_completions", "text/event-stream", [
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":50,"prompt_tokens_details":{"cached_tokens":20},"completion_tokens":4}}\n\n',
      "data: [DONE]\n\n",
    ])).toEqual({
      cacheWriteTokens: 0,
      cachedInputTokens: 20,
      inputTokens: 30,
      outputTokens: 4,
    });
  });
});
