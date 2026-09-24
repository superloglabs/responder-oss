import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeGrafanaCloudStackUrl,
  normalizeGrafanaUrl,
  parseGrafanaCredentials,
} from "./grafana.js";

describe("Grafana endpoints", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("derives the stack-scoped Grafana Cloud MCP endpoint", () => {
    const expected = {
      mcpUrl: "https://mcp.grafana.com/mcp/acme.grafana.net",
      stackHost: "acme.grafana.net",
      stackUrl: "https://acme.grafana.net",
    };
    expect(normalizeGrafanaCloudStackUrl("acme")).toEqual(expected);
    expect(normalizeGrafanaCloudStackUrl("acme.grafana.net")).toEqual(expected);
    expect(
      normalizeGrafanaCloudStackUrl("https://ACME.grafana.net/d/abc?orgId=1"),
    ).toEqual(expected);
  });

  it("rejects hosts outside Grafana Cloud", () => {
    for (const value of [
      "https://grafana.example.com",
      "https://acme.grafana.net.example.com",
      "http://acme.grafana.net",
      "https://user:pass@acme.grafana.net",
      "https://acme.grafana.net:8443",
      "https://a.b.grafana.net",
    ]) {
      expect(() => normalizeGrafanaCloudStackUrl(value)).toThrow(
        "Grafana Cloud stack URL",
      );
    }
  });

  it("normalizes self-hosted Grafana URLs with sub-paths", () => {
    expect(normalizeGrafanaUrl("https://grafana.example.com/")).toBe(
      "https://grafana.example.com",
    );
    expect(normalizeGrafanaUrl(" https://example.com/grafana/ ")).toBe(
      "https://example.com/grafana",
    );
    expect(normalizeGrafanaUrl("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
  });

  it("rejects insecure or credential-bearing self-hosted URLs", () => {
    expect(() => normalizeGrafanaUrl("http://grafana.example.com")).toThrow(
      "must use HTTPS",
    );
    expect(() =>
      normalizeGrafanaUrl("https://admin:secret@grafana.example.com"),
    ).toThrow("cannot contain credentials");
    expect(() =>
      normalizeGrafanaUrl("https://grafana.example.com/?orgId=1"),
    ).toThrow("query parameters");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => normalizeGrafanaUrl("http://localhost:3000")).toThrow(
      "must use HTTPS",
    );
  });

  it("rejects stored OAuth credentials whose MCP URL does not match the stack", () => {
    expect(() =>
      parseGrafanaCredentials({
        authType: "oauth",
        mcpUrl: "https://mcp.grafana.com/mcp/other.grafana.net",
        oauth: {},
        stackUrl: "https://acme.grafana.net",
      }),
    ).toThrow("does not match its stack");
    expect(
      parseGrafanaCredentials({
        authType: "service_account",
        grafanaUrl: "https://grafana.example.com/",
        serviceAccountToken: "glsa_test",
      }),
    ).toEqual({
      authType: "service_account",
      grafanaUrl: "https://grafana.example.com",
      serviceAccountToken: "glsa_test",
    });
  });
});
