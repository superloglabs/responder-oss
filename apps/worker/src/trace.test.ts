import { describe, expect, it } from "vitest";
import { investigationTraceEventFromStream } from "./trace.js";

const at = new Date("2026-08-05T13:00:00.000Z");

describe("investigation trace events", () => {
  it("stores completed assistant messages in the existing page format", () => {
    expect(
      investigationTraceEventFromStream(
        {
          type: "run_item_stream_event",
          name: "message_output_created",
          item: {
            content: "I found the failing request.",
            rawItem: {},
          },
        } as never,
        {},
        at,
      ),
    ).toEqual({
      data: { message: "I found the failing request." },
      meta: { at: "2026-08-05T13:00:00.000Z" },
      type: "message.completed",
    });
  });

  it("stores reasoning summaries when the model provides them", () => {
    expect(
      investigationTraceEventFromStream(
        {
          type: "run_item_stream_event",
          name: "reasoning_item_created",
          item: {
            rawItem: {
              rawContent: [{ type: "reasoning_text", text: "Check the logs first." }],
            },
          },
        } as never,
        {},
        at,
      ),
    ).toEqual({
      data: { reasoning: "Check the logs first." },
      meta: { at: "2026-08-05T13:00:00.000Z" },
      type: "reasoning.completed",
    });
  });

  it("pairs tool calls and results by call id", () => {
    const requested = investigationTraceEventFromStream(
      {
        type: "run_item_stream_event",
        name: "tool_called",
        item: {
          callId: "call_1",
          toolName: "bash",
          rawItem: {
            action: { commands: ["rg error app.log"] },
            type: "shell_call",
          },
        },
      } as never,
      {},
      at,
    );
    const completed = investigationTraceEventFromStream(
      {
        type: "run_item_stream_event",
        name: "tool_output",
        item: {
          callId: "call_1",
          output: { stdout: "one error" },
          rawItem: { status: "completed" },
        },
      } as never,
      {},
      at,
    );

    expect(requested?.data).toEqual({
      actions: [
        {
          callId: "call_1",
          input: { commands: ["rg error app.log"] },
          kind: "tool-call",
          toolName: "bash",
        },
      ],
    });
    expect(completed?.data).toEqual({
      result: {
        callId: "call_1",
        kind: "tool-result",
        output: { stdout: "one error" },
      },
      status: "completed",
    });
  });

  it("removes keys and secret-shaped fields from stored events", () => {
    const event = investigationTraceEventFromStream(
      {
        type: "run_item_stream_event",
        name: "tool_output",
        item: {
          callId: "call_1",
          output: {
            authorization: "Bearer hidden",
            message: "request used openai-secret",
          },
          rawItem: { status: "completed" },
        },
      } as never,
      { OPENAI_API_KEY: "openai-secret" },
      at,
    );

    expect(event?.data).toEqual({
      result: {
        callId: "call_1",
        kind: "tool-result",
        output: {
          authorization: "[redacted]",
          message: "request used [redacted]",
        },
      },
      status: "completed",
    });
  });

  it("ignores token-by-token model events", () => {
    expect(
      investigationTraceEventFromStream(
        { type: "raw_model_stream_event", data: {} } as never,
        {},
        at,
      ),
    ).toBeNull();
  });
});
