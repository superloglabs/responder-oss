import { decryptCredentials } from "../../../../packages/core/src/credentials/encryption.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationConnectionState } from "../../../../packages/core/src/db/integrations.js";
import { organizationHasCapability } from "../../../../packages/core/src/db/organization-capabilities.js";
import { executeOperation } from "./execute.js";
import { integrationConnectionOperations } from "./integration-connections.js";
import type { ManagementContext } from "./operation.js";

vi.mock("../../../../packages/core/src/db/integrations.js", async (original) => ({
  ...await original(),
  createIntegrationConnectionState: vi.fn().mockResolvedValue("private-state"),
}));
vi.mock("../../../../packages/core/src/db/organization-capabilities.js", async (original) => ({
  ...await original(), organizationHasCapability: vi.fn().mockResolvedValue(true),
}));

const caller: ManagementContext = {
  organizationId: "11111111-1111-4111-8111-111111111111", apiKeyId: null,
  oauthClientId: "chat-client", source: "mcp", role: "member",
  user: { id: "22222222-2222-4222-8222-222222222222", name: "Ash", email: "ash@example.com" },
};
const start = integrationConnectionOperations.find((item) => item.name === "start_integration_connection")!;
const list = integrationConnectionOperations.find((item) => item.name === "list_available_integrations")!;

function consentUrl(body: Record<string, unknown>) {
  expect(body.url).toBe(body.handoffUrl);
  const handoff = new URL(body.url as string);
  expect(handoff.origin).toBe("https://superlog.example");
  expect(handoff.pathname).toBe("/api/integrations/chat/open");
  const envelope = decryptCredentials<{ authorizationUrl: string }>(handoff.searchParams.get("token")!);
  return new URL(envelope.authorizationUrl);
}

describe("connections from chat", () => {
  beforeEach(() => {
    for (const key of ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET",
      "GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_PRIVATE_KEY", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET",
      "LINEAR_CLIENT_ID", "LINEAR_CLIENT_SECRET"]) vi.stubEnv(key, "configured");
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 9).toString("base64"));
    vi.stubEnv("SLACK_CLIENT_SECRET", "private-slack-secret");
    vi.stubEnv("BETTER_AUTH_URL", "https://superlog.example");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://superlog.example");
  });
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

  it("returns Slack consent and binds state to the authenticated caller, not supplied IDs", async () => {
    const result = await executeOperation(start, caller, {
      provider: "slack", organizationId: "another-workspace", userId: "someone-else",
      returnTo: "https://attacker.example", url: "https://attacker.example",
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ provider: "slack", status: "awaiting_consent", connectionType: "oauth" });
    const url = consentUrl(result.body);
    expect(url.origin).toBe("https://slack.com");
    expect(url.searchParams.get("state")).toBe("private-state");
    expect(createIntegrationConnectionState).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: caller.organizationId, userId: caller.user.id, provider: "slack", returnTo: expect.stringContaining("/api/integrations/chat/complete?ticket="),
    }));
    expect(Date.parse(result.body.expiresAt as string) - Date.now()).toBeGreaterThan(590_000);
    expect(Date.parse(result.body.expiresAt as string) - Date.now()).toBeLessThanOrEqual(600_000);
    expect(JSON.stringify(result.body)).not.toContain("private-slack-secret");
  });

  it("uses GitHub installation consent so repository access can be selected", async () => {
    const result = await executeOperation(start, caller, { provider: "github" });
    expect(result.status).toBe(200);
    const url = consentUrl(result.body);
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toContain("/installations/new");
    expect(url.searchParams.get("state")).toBe("private-state");
  });

  it("retains PKCE when starting Linear from chat", async () => {
    const result = await executeOperation(start, caller, { provider: "linear" });
    expect(result.status).toBe(200);
    const url = consentUrl(result.body);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(createIntegrationConnectionState).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: caller.organizationId, userId: caller.user.id,
      provider: "linear", codeVerifier: expect.any(String),
    }));
    const verifier = vi.mocked(createIntegrationConnectionState).mock.calls[0]![0].codeVerifier;
    expect(JSON.stringify(result.body)).not.toContain(verifier);
  });

  it("does not pretend credential setup is OAuth or collect credentials", async () => {
    const result = await executeOperation(start, caller, { provider: "datadog", apiKey: "must-not-echo" });
    expect(result.body).toMatchObject({ connectionType: "secure_setup", status: "setup_required", expiresAt: null });
    expect(createIntegrationConnectionState).not.toHaveBeenCalled();
    expect(JSON.stringify(result.body)).not.toContain("must-not-echo");
  });

  it("rejects unknown and unconfigured providers before creating state", async () => {
    vi.stubEnv("SLACK_CLIENT_ID", "");
    expect((await executeOperation(start, caller, { provider: "unknown" })).status).toBe(400);
    expect((await executeOperation(start, caller, { provider: "slack" })).body.code).toBe("integration_not_configured");
    expect(createIntegrationConnectionState).not.toHaveBeenCalled();
  });

  it("keeps capability-gated providers out of discovery and connection", async () => {
    vi.mocked(organizationHasCapability).mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    const result = await executeOperation(list, caller, {});
    expect(result.status).toBe(200);
    expect(result.body.integrations).not.toEqual(expect.arrayContaining([expect.objectContaining({ provider: "discord" })]));
    expect((await executeOperation(start, caller, { provider: "discord" })).status).toBe(404);
    expect(createIntegrationConnectionState).not.toHaveBeenCalled();
  });
});
