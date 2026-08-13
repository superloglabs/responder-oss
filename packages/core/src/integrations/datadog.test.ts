import { describe, expect, it } from "vitest";
import {
  DATADOG_OAUTH_RESOURCE,
  getDatadogSite,
} from "./datadog.js";

describe("Datadog sites", () => {
  it("maps EU1 to its regional MCP endpoint", () => {
    expect(getDatadogSite("datadoghq.eu")).toMatchObject({
      id: "datadoghq.eu",
      name: "EU1",
      mcpUrl: "https://mcp.datadoghq.eu/v1/mcp",
    });
  });

  it("keeps US1 as the legacy default", () => {
    expect(getDatadogSite(undefined).mcpUrl).toBe(DATADOG_OAUTH_RESOURCE);
  });

  it("rejects an unknown Datadog site instead of silently using US1", () => {
    expect(() => getDatadogSite("unknown.datadog.example")).toThrow(
      "Unsupported Datadog site",
    );
  });
});
