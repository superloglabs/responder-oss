import { describe, expect, it, vi } from "vitest";
import type { AwsTemporaryCredentials } from "./aws.js";
import {
  createAwsMcpFetch,
  createRefreshingAwsCredentialsProvider,
} from "./aws-mcp.js";

const connection = {
  accountId: "integration-account-1",
  externalId: "responder_abcdefghijklmnopqrstuvwxyz1234567890",
  roleArn: "arn:aws:iam::123456789012:role/ResponderInvestigationRole",
};

describe("AWS credential refresh", () => {
  it("reuses valid credentials and refreshes credentials nearing expiration", async () => {
    let now = Date.parse("2026-08-17T12:00:00Z");
    const assume = async () => ({
      accessKeyId: `access-${now}`,
      expiration: new Date(now + 60 * 60 * 1_000),
      secretAccessKey: "secret",
      sessionToken: "token",
    });
    const provider = createRefreshingAwsCredentialsProvider(
      connection,
      {},
      assume,
      () => now,
    );

    const first = await provider();
    expect(await provider()).toBe(first);
    now += 56 * 60 * 1_000;
    expect(await provider()).not.toBe(first);
  });

  it("shares an in-flight refresh between concurrent requests", async () => {
    let resolveCredentials:
      | ((credentials: AwsTemporaryCredentials) => void)
      | undefined;
    const assume = () =>
      new Promise<AwsTemporaryCredentials>((resolve) => {
        resolveCredentials = resolve;
      });
    const provider = createRefreshingAwsCredentialsProvider(
      connection,
      {},
      assume,
    );
    const first = provider();
    const second = provider();
    const credentials = {
      accessKeyId: "access",
      expiration: new Date(Date.now() + 60 * 60 * 1_000),
      secretAccessKey: "secret",
      sessionToken: "token",
    };
    resolveCredentials?.(credentials);
    await expect(Promise.all([first, second])).resolves.toEqual([
      credentials,
      credentials,
    ]);
  });
});

describe("AWS MCP request signing", () => {
  it("signs the request body and headers with the role session", async () => {
    const baseFetch = vi.fn(async () => new Response("{}"));
    const signedFetch = createAwsMcpFetch(async () => ({
      accessKeyId: "AKIATESTACCESSKEY",
      expiration: new Date(Date.now() + 60 * 60 * 1_000),
      secretAccessKey: "secret",
      sessionToken: "session-token",
    }), baseFetch);

    await signedFetch("https://aws-mcp.us-east-1.api.aws/mcp", {
      body: "{\"jsonrpc\":\"2.0\"}",
      headers: { "mcp-session-id": "session" },
      method: "POST",
    });

    const [url, init] = baseFetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://aws-mcp.us-east-1.api.aws/mcp");
    expect(new TextDecoder().decode(init.body as Uint8Array)).toBe("{\"jsonrpc\":\"2.0\"}");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIATESTACCESSKEY\/\d{8}\/us-east-1\/aws-mcp\/aws4_request, SignedHeaders=[^,]*mcp-session-id/u,
    );
    expect(headers.get("x-amz-security-token")).toBe("session-token");
    expect(headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/u);
  });
});
