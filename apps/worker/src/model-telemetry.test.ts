import { trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { modelCallTelemetry } from "./model-telemetry.js";

describe("model call telemetry", () => {
  const exporter = new InMemorySpanExporter();

  beforeAll(() => {
    trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
  });
  afterAll(() => trace.disable());

  it("records the model and tokens of a call, without its prompt or output", async () => {
    await generateText({
      model: new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [{ text: "secret output", type: "text" }],
          finishReason: { raw: undefined, unified: "stop" },
          usage: {
            inputTokens: { cacheRead: 30, cacheWrite: undefined, noCache: 70, total: 100 },
            outputTokens: { reasoning: undefined, text: 20, total: 20 },
          },
          warnings: [],
        }),
        modelId: "claude-sonnet-5.5",
        provider: "anthropic",
      }),
      prompt: "secret prompt",
      system: "secret instructions",
      telemetry: modelCallTelemetry("test-call"),
    });

    const spans = exporter.getFinishedSpans();
    const call = spans.find((span) => span.attributes["gen_ai.operation.name"] === "chat");
    expect(call?.attributes).toMatchObject({
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-sonnet-5.5",
      "gen_ai.usage.cache_read.input_tokens": 30,
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.output_tokens": 20,
    });
    const recorded = JSON.stringify(spans.map((span) => span.attributes));
    expect(recorded).not.toContain("secret");
  });
});
