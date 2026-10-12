import { describe, expect, it, vi } from "vitest";
import {
  grafanaSelfHostedArgs,
  grafanaSelfHostedProcess,
  isGrafanaReadOnlyTool,
} from "./grafana-mcp.js";

vi.mock("./egress-proxy.js", () => ({
  startEgressProxy: vi.fn(async () => ({
    close: async () => undefined,
    server: { unref: vi.fn() },
    url: "socks5h://127.0.0.1:41000",
  })),
}));

describe("Grafana MCP", () => {
  it("disables write, raw API, and SQL tools in the self-hosted process", () => {
    const args = grafanaSelfHostedArgs();
    const enabledTools = args
      .find((arg) => arg.startsWith("--enabled-tools="))!
      .slice("--enabled-tools=".length)
      .split(",");

    expect(args).toContain("--disable-write");
    expect(args).toContain("--usage-stats=disabled");
    expect(enabledTools).toEqual(
      expect.arrayContaining(["prometheus", "loki", "dashboard", "alerting"]),
    );
    for (const category of ["api", "sql", "admin", "provisioning", "rendering"]) {
      expect(enabledTools).not.toContain(category);
    }
  });

  it("starts mcp-grafana with only the connection's credential and the egress proxy", async () => {
    await expect(grafanaSelfHostedProcess(
      { grafanaUrl: "https://grafana.example.com", serviceAccountToken: "glsa_token" },
      { MCP_GRAFANA_BINARY: "/usr/local/bin/mcp-grafana" },
    )).resolves.toEqual({
      args: grafanaSelfHostedArgs(),
      command: "/usr/local/bin/mcp-grafana",
      env: {
        DO_NOT_TRACK: "1",
        GRAFANA_SERVICE_ACCOUNT_TOKEN: "glsa_token",
        GRAFANA_SOCKS5_PROXY: "socks5h://127.0.0.1:41000",
        GRAFANA_URL: "https://grafana.example.com",
      },
    });
  });

  it("allows only tools annotated read-only", () => {
    expect(isGrafanaReadOnlyTool({ annotations: { readOnlyHint: true }, name: "query_prometheus" })).toBe(true);
    expect(isGrafanaReadOnlyTool({ name: "update_dashboard" })).toBe(false);
    expect(isGrafanaReadOnlyTool({ annotations: { readOnlyHint: false }, name: "create_incident" })).toBe(false);
    expect(isGrafanaReadOnlyTool(null)).toBe(false);
  });
});
