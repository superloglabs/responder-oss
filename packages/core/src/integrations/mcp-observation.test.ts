import { describe, expect, it } from "vitest";
import { isObservationTool } from "./mcp-observation.js";

const tool = (name: string, annotations?: Record<string, unknown>) => ({
  name,
  ...(annotations ? { annotations } : {}),
});

describe("isObservationTool", () => {
  it("allows tools that declare themselves read-only or whose names only read", () => {
    expect(isObservationTool(tool("search_datadog_logs"))).toBe(true);
    expect(isObservationTool(tool("start_query", { readOnlyHint: true }))).toBe(true);
    expect(isObservationTool(tool("getAlert"))).toBe(true);
  });

  it("refuses tools that declare writes or whose names say they write", () => {
    expect(isObservationTool(tool("create_datadog_monitor"))).toBe(false);
    expect(isObservationTool(tool("createMonitor"))).toBe(false);
    expect(isObservationTool(tool("list_things", { readOnlyHint: false }))).toBe(false);
    expect(isObservationTool(tool("get_things", { destructiveHint: true, readOnlyHint: true }))).toBe(false);
  });
});
