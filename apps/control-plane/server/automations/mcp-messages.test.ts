import { describe, expect, it } from "vitest";
import { rpcMessages } from "./mcp-messages.js";

describe("MCP response messages", () => {
  it("skips events whose data is empty", () => {
    expect(rpcMessages(
      "event: ping\ndata:\n\ndata: {\"id\":1}\n\n",
      "text/event-stream",
    )).toEqual([{ id: 1 }]);
  });
});
