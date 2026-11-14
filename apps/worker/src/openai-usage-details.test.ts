import { OpenAIResponsesModel, protocol, withTrace, type ModelRequest } from "@openai/agents";
import type OpenAI from "openai";
import { describe, expect, it } from "vitest";

// OpenAI sends nested objects such as cache_write_tokens_details inside the
// usage details. The patch on @openai/agents-openai keeps only the number
// counts, which the Agents SDK usage schema accepts.
const usage = {
  input_tokens: 1_200,
  input_tokens_details: {
    cached_tokens: 800,
    cache_write_tokens_details: { ephemeral_5m_input_tokens: 400 },
  },
  output_tokens: 50,
  output_tokens_details: { reasoning_tokens: 10 },
  total_tokens: 1_250,
};

const response = {
  id: "resp_1",
  object: "response",
  created_at: 0,
  model: "gpt-5.6-sol",
  output: [],
  status: "completed",
  usage,
};

function fakeClient(): OpenAI {
  return {
    baseURL: "https://api.openai.com/v1",
    responses: {
      create: async (body: { stream?: boolean }) => {
        if (!body.stream) return response;
        return (async function* () {
          yield { type: "response.completed", response, sequence_number: 0 };
        })();
      },
    },
  } as unknown as OpenAI;
}

const request: ModelRequest = {
  input: "hello",
  modelSettings: {},
  tools: [],
  handoffs: [],
  outputType: "text",
  tracing: false,
};

describe("OpenAI usage details", () => {
  it("accepts a streamed response whose usage details hold nested objects", async () => {
    const model = new OpenAIResponsesModel(fakeClient(), "gpt-5.6-sol");
    const events = [];
    for await (const event of model.getStreamedResponse(request)) events.push(event);
    const done = events.find((event) => event.type === "response_done");

    const parsed = protocol.StreamEventResponseCompleted.parse(done);

    expect(parsed.response.usage.inputTokensDetails).toEqual({ cached_tokens: 800 });
    expect(parsed.response.usage.outputTokensDetails).toEqual({ reasoning_tokens: 10 });
    expect(parsed.response.usage.requestUsageEntries?.[0]?.inputTokensDetails)
      .toEqual({ cached_tokens: 800 });
  });

  it("keeps only number counts in a non-streamed response's usage", async () => {
    const model = new OpenAIResponsesModel(fakeClient(), "gpt-5.6-sol");

    const result = await withTrace("usage details", () => model.getResponse(request));

    expect(result.usage.inputTokensDetails).toEqual([{ cached_tokens: 800 }]);
    expect(result.usage.requestUsageEntries?.[0]?.inputTokensDetails)
      .toEqual({ cached_tokens: 800 });
  });
});
