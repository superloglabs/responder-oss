import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managementMcpRoutes } from "./mcp.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";
const token = `slk_${"a".repeat(43)}`;

const mocks = vi.hoisted(() => ({
  capability: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/api-keys.js", () => ({
  authenticateApiKey: vi.fn().mockResolvedValue({
    apiKeyId: "31313131-3131-4131-8131-313131313131",
    organizationId: "15151515-1515-4515-8515-151515151515",
    role: "member",
    user: { email: "ash@example.com", id: "21212121-2121-4121-8121-212121212121", name: "Ash" },
  }),
  listApiKeys: vi.fn().mockResolvedValue([]),
  revokeApiKey: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/oauth-access-tokens.js", () => ({
  authenticateOAuthAccessToken: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/organization-capabilities.js", () => ({
  listEnabledOrganizationCapabilities: vi.fn().mockResolvedValue(["signal"]),
  organizationHasCapability: mocks.capability,
}));

const app = new Hono().route("/api/mcp", managementMcpRoutes);

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const response = await app.request("/api/mcp", {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name } }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  const { result } = await response.json() as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { body: JSON.parse(result.content[0]!.text) as Record<string, unknown>, isError: result.isError };
}

const finding = {
  id: "SIG-012",
  title: "Checkout fails for saved cards",
  subtitle: "Stripe rejects the stored payment method",
  severity: "SEV-2",
  service: "checkout",
  status: "new",
  impact: "Customers with saved cards cannot pay.",
  affectedUsers: 41,
  affectedRequests: null,
  rootCause: "The card lookup uses the wrong customer ID.",
  suggestedFix: "Look the card up by the Stripe customer ID.",
  evidence: [{ kind: "logs", title: "Card errors", detail: "312 errors since 09:00" }],
  prompt: "Fix the card lookup in checkout.",
  postedAt: "2026-11-16T09:12:00.000Z",
  slackChannelId: "C0123",
};

describe("Signal operations", () => {
  beforeEach(() => {
    vi.stubEnv("RESPONDER_EXTENSION_URL", "http://signal.internal:3100");
    vi.stubEnv("RESPONDER_EXTENSION_TOKEN", "extension-token");
    vi.stubEnv("RESPONDER_EXTENSION_PATH_PREFIX", "/api/signal");
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.capability.mockImplementation(async (_organization: string, capability: string) => capability === "signal");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("reads a finding from Signal as the caller", async () => {
    mocks.fetch.mockResolvedValue(Response.json(finding));

    const result = await callTool("get_signal_finding", { findingId: "sig-012" });

    expect(result.isError).toBeUndefined();
    // Fields the tool does not document, such as the Slack channel, are left out.
    expect(result.body).toEqual({ finding: {
      ...finding, slackChannelId: undefined, url: "http://localhost:3000/signal/findings/SIG-012",
    } });
    const [target, init] = mocks.fetch.mock.calls[0]! as [URL, RequestInit];
    expect(target.href).toBe("http://signal.internal:3100/api/signal/findings/SIG-012");
    expect(init.headers).toMatchObject({
      authorization: "Bearer extension-token",
      "x-responder-member-role": "member",
      "x-responder-organization-id": organizationId,
      "x-responder-user-id": userId,
    });
  });

  it("refuses an ID that is not a finding's", async () => {
    const result = await callTool("get_signal_finding", { findingId: "../settings" });

    expect(result.isError).toBe(true);
    expect(result.body).toMatchObject({ code: "invalid_request" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("says when the finding does not exist, or Signal refuses the caller", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ error: "Finding not found." }, { status: 404 }));
    expect((await callTool("get_signal_finding", { findingId: "SIG-404" })).body)
      .toMatchObject({ code: "signal_finding_not_found" });

    mocks.fetch.mockResolvedValueOnce(Response.json({ error: "Signal is not available." }, { status: 403 }));
    expect((await callTool("get_signal_finding", { findingId: "SIG-012" })).body)
      .toMatchObject({ code: "signal_unavailable" });
  });

  it("reports Signal being down without its details", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.fetch.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await callTool("get_signal_finding", { findingId: "SIG-012" })).body).toMatchObject({ code: "signal_error" });

    mocks.fetch.mockResolvedValueOnce(new Response("upstream", { status: 500 }));
    expect((await callTool("get_signal_finding", { findingId: "SIG-012" })).body).toMatchObject({ code: "signal_error" });
    error.mockRestore();
  });

  it("does not reach Signal for a workspace without it", async () => {
    mocks.capability.mockResolvedValue(false);

    const result = await callTool("get_signal_finding", { findingId: "SIG-012" });

    expect(result.body).toMatchObject({ code: "signal_unavailable" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
