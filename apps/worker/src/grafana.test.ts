import { safeCustomMcpFetch } from "@responder/core/integrations/custom-mcp";
import { grafanaSelfHostedArgs } from "@responder/core/integrations/grafana-mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGrafanaMcpServer,
  grafanaReadOnlyToolFilter,
} from "./grafana.js";

const { httpConstructor, stdioConstructor } = vi.hoisted(() => ({
  httpConstructor: vi.fn(),
  stdioConstructor: vi.fn(),
}));

vi.mock("@openai/agents", () => ({
  MCPServerStdio: class {
    constructor(options: unknown) {
      stdioConstructor(options);
    }
  },
  MCPServerStreamableHttp: class {
    constructor(options: unknown) {
      httpConstructor(options);
    }
  },
}));

vi.mock("@responder/core/integrations/egress-proxy", () => ({
  startEgressProxy: vi.fn(async () => ({
    close: async () => undefined,
    server: { unref: vi.fn() },
    url: "socks5h://127.0.0.1:41000",
  })),
}));

describe("Grafana MCP", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("connects Grafana Cloud through the guarded hosted MCP endpoint", async () => {
    await createGrafanaMcpServer({
      accessToken: "cloud-access-token",
      accountId: "account-1",
      authType: "oauth",
      displayName: "acme.grafana.net",
      mcpUrl: "https://mcp.grafana.com/mcp/acme.grafana.net",
    });

    expect(httpConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        fetch: safeCustomMcpFetch,
        name: "grafana-account-1",
        requestInit: {
          headers: { authorization: "Bearer cloud-access-token" },
        },
        toolFilter: grafanaReadOnlyToolFilter,
        url: "https://mcp.grafana.com/mcp/acme.grafana.net",
      }),
    );
    expect(stdioConstructor).not.toHaveBeenCalled();
  });

  it("runs self-hosted Grafana through a read-only mcp-grafana process", async () => {
    await createGrafanaMcpServer(
      {
        accountId: "account-2",
        authType: "service_account",
        displayName: "grafana.example.com · Main Org.",
        grafanaUrl: "https://grafana.example.com",
        serviceAccountToken: "glsa_token",
      },
      { MCP_GRAFANA_BINARY: "/usr/local/bin/mcp-grafana" },
    );

    expect(stdioConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        args: grafanaSelfHostedArgs(),
        command: "/usr/local/bin/mcp-grafana",
        env: {
          DO_NOT_TRACK: "1",
          GRAFANA_SERVICE_ACCOUNT_TOKEN: "glsa_token",
          GRAFANA_SOCKS5_PROXY: "socks5h://127.0.0.1:41000",
          GRAFANA_URL: "https://grafana.example.com",
        },
        name: "grafana-account-2",
        toolFilter: grafanaReadOnlyToolFilter,
      }),
    );
  });

  it("exposes only tools annotated read-only", async () => {
    await expect(
      grafanaReadOnlyToolFilter(null, {
        annotations: { readOnlyHint: true },
        name: "query_prometheus",
      }),
    ).resolves.toBe(true);
    await expect(
      grafanaReadOnlyToolFilter(null, { name: "update_dashboard" }),
    ).resolves.toBe(false);
    await expect(
      grafanaReadOnlyToolFilter(null, {
        annotations: { readOnlyHint: false },
        name: "create_incident",
      }),
    ).resolves.toBe(false);
  });
});
