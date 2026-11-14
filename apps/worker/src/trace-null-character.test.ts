import { describe, expect, it } from "vitest";
import { investigationTraceEventFromStream } from "./trace.js";

describe("investigation trace text", () => {
  it("removes null characters that Postgres cannot store", () => {
    const event = investigationTraceEventFromStream(
      {
        type: "run_item_stream_event",
        name: "tool_output",
        item: {
          callId: "call_sentry",
          output: { type: "text", text: "params: abc\u0000def" },
          rawItem: { status: "completed" },
        },
      } as never,
      {},
      new Date("2026-11-14T19:58:20.000Z"),
    );

    expect(JSON.stringify(event)).not.toContain("\\u0000");
    expect(event?.data).toEqual({
      result: {
        callId: "call_sentry",
        kind: "tool-result",
        output: { type: "text", text: "params: abcdef" },
      },
      status: "completed",
    });
  });
});
