import { describe, expect, it } from "vitest";
import {
  connectionSecrets,
  containsDaytonaSecretPlaceholder,
  redactSecrets,
  workspaceSecretUsageInstructions,
} from "./secret-safety.js";

describe("workspace secret safety", () => {
  it("detects placeholders case-insensitively in binary file contents", () => {
    expect(
      containsDaytonaSecretPlaceholder(
        new TextEncoder().encode("token=DTN_SECRET_1234-ABCD"),
      ),
    ).toBe(true);
  });

  it("fails closed when a value cannot be inspected", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(containsDaytonaSecretPlaceholder(circular)).toBe(true);
  });

  it("renders one shared host-restricted usage policy", () => {
    const instructions = workspaceSecretUsageInstructions([
      {
        environmentVariable: "SERVICE_API_KEY",
        allowedHosts: ["api.example.com"],
      },
    ]);

    expect(instructions).toContain("SERVICE_API_KEY");
    expect(instructions).toContain("api.example.com");
    expect(instructions).toContain("Never send a placeholder to an unlisted host");
  });
});

describe("connection secret redaction", () => {
  it("collects credentials from every connection shape", () => {
    expect(
      connectionSecrets([
        { accessToken: "oauth-access-token", mcpUrl: "https://mcp.example.com/mcp" },
        { apiKey: "datadog-api-key", applicationKey: "datadog-app-key" },
        { accessKey: "clickstack-access-key" },
        { serviceAccountToken: "glsa_service_token" },
        { publicKey: "pk-lf-public", secretKey: "sk-lf-secret-key" },
        { externalId: "aws-external-id", roleArn: "arn:aws:iam::123456789012:role/x" },
        { userAccessToken: "xoxp-user-token" },
        null,
        undefined,
      ]).sort(),
    ).toEqual([
      "aws-external-id",
      "clickstack-access-key",
      "datadog-api-key",
      "datadog-app-key",
      "glsa_service_token",
      "oauth-access-token",
      "pk-lf-public",
      "sk-lf-secret-key",
      "xoxp-user-token",
    ]);
  });

  it("treats query parameters in configured MCP URLs as credentials", () => {
    expect(
      connectionSecrets([
        { mcpUrl: "https://mcp.example.com/mcp?api_key=query-secret-value&x=1" },
      ]),
    ).toEqual(["query-secret-value"]);
  });

  it("ignores values too short to redact safely", () => {
    expect(connectionSecrets([{ apiKey: "short" }])).toEqual([]);
  });

  it("keeps the provider error and removes only the credentials", () => {
    expect(
      redactSecrets(
        "HTTP 401 for token oauth-access-token (prefix oauth-access)",
        ["oauth-access", "oauth-access-token"],
      ),
    ).toBe("HTTP 401 for token [redacted] (prefix [redacted])");
  });
});
