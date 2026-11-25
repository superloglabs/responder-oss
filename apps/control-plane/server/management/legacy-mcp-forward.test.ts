import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managementMcpRoutes } from "./mcp.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";

const mocks = vi.hoisted(() => ({
  authenticateApiKey: vi.fn(),
  authenticateOAuth: vi.fn(),
  claimAssertion: vi.fn(),
  findForwardedMember: vi.fn(),
  findMember: vi.fn(),
  getOrganizationSummary: vi.fn(),
  listCapabilities: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/legacy-mcp-forwarding.js", () => ({
  findLegacyMcpForwardMember: mocks.findMember,
  findForwardedWorkspaceMember: mocks.findForwardedMember,
  claimLegacyMcpForwardAssertion: mocks.claimAssertion,
}));
vi.mock("../../../../packages/core/src/db/api-keys.js", () => ({
  authenticateApiKey: mocks.authenticateApiKey,
}));
vi.mock("../../../../packages/core/src/db/oauth-access-tokens.js", () => ({
  authenticateOAuthAccessToken: mocks.authenticateOAuth,
}));
vi.mock("../../../../packages/core/src/db/organizations.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getOrganizationSummary: mocks.getOrganizationSummary,
}));
vi.mock("../../../../packages/core/src/db/organization-capabilities.js", () => ({
  listEnabledOrganizationCapabilities: mocks.listCapabilities,
  organizationHasCapability: vi.fn().mockResolvedValue(true),
}));

function forwarded(body: unknown, headers: Record<string, string> = {}) {
  return managementMcpRoutes.request("/", {
    body: JSON.stringify(body),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "x-legacy-mcp-access": "read-write",
      "x-legacy-mcp-forward-token": "forward-secret",
      "x-legacy-mcp-project-id": organizationId,
      "x-legacy-mcp-user-email": "Ash@Example.com",
      ...headers,
    },
    method: "POST",
  });
}

const listTools = { id: 1, jsonrpc: "2.0", method: "tools/list" };

async function toolNames(response: Response): Promise<string[]> {
  const body = await response.json() as { result: { tools: Array<{ name: string }> } };
  return body.result.tools.map((tool) => tool.name);
}

describe("MCP requests forwarded by the old product", () => {
  beforeEach(() => {
    vi.stubEnv("LEGACY_MCP_FORWARD_TOKEN", "forward-secret");
    mocks.findMember.mockResolvedValue({
      organizationId,
      role: "member",
      user: { email: "ash@example.com", id: userId, name: "Ash" },
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("acts as the workspace member with the token owner's email", async () => {
    mocks.listCapabilities.mockResolvedValue([]);
    mocks.getOrganizationSummary.mockResolvedValue({
      createdAt: new Date("2026-10-01T10:00:00.000Z"),
      id: organizationId,
      name: "Acme",
      slug: "acme",
    });

    const response = await forwarded(
      { id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name: "get_workspace" } },
      { authorization: "Bearer slk_ignored" },
    );
    const body = await response.json() as { result: { content: Array<{ text: string }> } };

    expect(response.status).toBe(200);
    expect(mocks.findMember).toHaveBeenCalledWith(organizationId, "Ash@Example.com");
    expect(mocks.authenticateApiKey).not.toHaveBeenCalled();
    expect(mocks.authenticateOAuth).not.toHaveBeenCalled();
    expect(JSON.parse(body.result.content[0]?.text ?? "{}")).toMatchObject({
      workspace: { id: organizationId, member: { email: "ash@example.com", userId } },
    });
  });

  it("offers every tool to a token that could write", async () => {
    const names = await toolNames(await forwarded(listTools));

    expect(names).toContain("create_alert");
    expect(names).toContain("query_logs");
  });

  it("offers only read-only tools to a token that could only read", async () => {
    for (const access of ["read", "anything-else"]) {
      const names = await toolNames(await forwarded(listTools, { "x-legacy-mcp-access": access }));

      expect(names).toContain("query_logs");
      expect(names).toContain("list_alerts");
      expect(names).not.toContain("create_alert");
      expect(names).not.toContain("update_dashboard");
    }

    const response = await forwarded(
      {
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { automationId: organizationId }, name: "cancel_automation_run" },
      },
      { "x-legacy-mcp-access": "read" },
    );
    const body = await response.json() as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(body.result).toMatchObject({ isError: true });
    expect(body.result.content[0]?.text).toBe("Unknown tool: cancel_automation_run");
  });

  it("refuses requests without the shared credential, or when none is configured", async () => {
    for (const token of ["wrong-secret", "", "forward-secret-and-more"]) {
      const response = await forwarded(listTools, { "x-legacy-mcp-forward-token": token });
      expect(response.status).toBe(403);
    }
    vi.stubEnv("LEGACY_MCP_FORWARD_TOKEN", "");
    const unconfigured = await forwarded(listTools);

    expect(unconfigured.status).toBe(403);
    expect(unconfigured.headers.get("www-authenticate")).toBeNull();
    expect(await unconfigured.json()).toMatchObject({ code: "forward_refused" });
    expect(mocks.findMember).not.toHaveBeenCalled();
  });

  it("refuses a malformed project ID or email", async () => {
    const malformed: Array<Record<string, string>> = [
      { "x-legacy-mcp-project-id": "not-a-uuid" },
      { "x-legacy-mcp-user-email": "" },
      { "x-legacy-mcp-user-email": "not an email" },
    ];
    for (const headers of malformed) {
      expect((await forwarded(listTools, headers)).status).toBe(403);
    }
    expect(mocks.findMember).not.toHaveBeenCalled();
  });

  it("refuses a workspace that is not in this cell or a person who is not its member", async () => {
    mocks.findMember.mockResolvedValue(null);

    const response = await forwarded(listTools);

    expect(response.status).toBe(403);
    expect(mocks.findMember).toHaveBeenCalledWith(organizationId, "Ash@Example.com");
  });
});

const cellOrigin = "https://cell.example.com";
const legacyProjectId = "16161616-1616-4616-8616-161616161616";

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function publicKeyText(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" });
  return jwk.x!;
}

type Claims = Record<string, unknown>;

function assertion(privateKey: KeyObject, claims: Claims, header: Claims = { alg: "EdDSA", typ: "JWT" }): string {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  return `${signingInput}.${base64url(sign(null, Buffer.from(signingInput), privateKey))}`;
}

describe("MCP requests forwarded by the old product with a signed assertion", () => {
  const signer = generateKeyPairSync("ed25519");
  const otherSigner = generateKeyPairSync("ed25519");
  const now = Math.floor(Date.now() / 1000);

  function claimsFor(body: string, overrides: Claims = {}): Claims {
    return {
      access: "read-write",
      aud: cellOrigin,
      body: base64url(createHash("sha256").update(body).digest()),
      email: "Ash@Example.com",
      exp: now + 60,
      iat: now,
      iss: "superlog-legacy-mcp",
      jti: randomUUID(),
      project: legacyProjectId,
      ...overrides,
    };
  }

  function signedForward(
    message: unknown,
    { claims = {}, headers = {}, key = signer.privateKey, rawBody }: {
      claims?: Claims;
      headers?: Record<string, string>;
      key?: KeyObject;
      rawBody?: string;
    } = {},
  ) {
    const body = JSON.stringify(message);
    return managementMcpRoutes.request("/", {
      body: rawBody ?? body,
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "x-legacy-mcp-assertion": assertion(key, claimsFor(body, claims)),
        ...headers,
      },
      method: "POST",
    });
  }

  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_URL", cellOrigin);
    vi.stubEnv("LEGACY_MCP_FORWARD_TOKEN", "");
    vi.stubEnv(
      "LEGACY_MCP_FORWARD_PUBLIC_KEYS",
      `${publicKeyText(otherSigner.publicKey)}, ${publicKeyText(signer.publicKey)}`,
    );
    mocks.listCapabilities.mockResolvedValue([]);
    mocks.claimAssertion.mockResolvedValue(true);
    mocks.findForwardedMember.mockResolvedValue({
      organizationId,
      role: "member",
      user: { email: "ash@example.com", id: userId, name: "Ash" },
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("acts as the member of the workspace the old project moved to", async () => {
    mocks.getOrganizationSummary.mockResolvedValue({
      createdAt: new Date("2026-10-01T10:00:00.000Z"),
      id: organizationId,
      name: "Acme",
      slug: "acme",
    });

    const response = await signedForward(
      { id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: {}, name: "get_workspace" } },
    );
    const body = await response.json() as { result: { content: Array<{ text: string }> } };

    expect(response.status).toBe(200);
    expect(mocks.findForwardedMember).toHaveBeenCalledWith(legacyProjectId, "Ash@Example.com");
    expect(mocks.findMember).not.toHaveBeenCalled();
    expect(JSON.parse(body.result.content[0]?.text ?? "{}")).toMatchObject({
      workspace: { id: organizationId, member: { email: "ash@example.com", userId } },
    });
  });

  it("offers only read-only tools when the assertion grants read access", async () => {
    const names = await toolNames(await signedForward(listTools, { claims: { access: "read" } }));

    expect(names).toContain("query_logs");
    expect(names).not.toContain("create_alert");
  });

  it("uses the assertion and ignores a shared credential sent with it", async () => {
    vi.stubEnv("LEGACY_MCP_FORWARD_TOKEN", "forward-secret");

    const response = await signedForward(listTools, {
      headers: { "x-legacy-mcp-forward-token": "forward-secret" },
      key: generateKeyPairSync("ed25519").privateKey,
    });

    expect(response.status).toBe(403);
    expect(mocks.findMember).not.toHaveBeenCalled();
  });

  it("refuses an assertion signed by another key, or when no key is configured", async () => {
    const unknownKey = await signedForward(listTools, { key: generateKeyPairSync("ed25519").privateKey });
    expect(unknownKey.status).toBe(403);
    expect(await unknownKey.json()).toMatchObject({ code: "forward_refused" });

    vi.stubEnv("LEGACY_MCP_FORWARD_PUBLIC_KEYS", "");
    expect((await signedForward(listTools)).status).toBe(403);
    expect(mocks.findForwardedMember).not.toHaveBeenCalled();
  });

  it("refuses an expired, future, long-lived, or other-cell assertion", async () => {
    const refused: Claims[] = [
      { exp: now - 60, iat: now - 120 },
      { exp: now + 600, iat: now + 540 },
      { exp: now + 3600 },
      { aud: "https://other-cell.example.com" },
      { iss: "someone-else" },
    ];
    for (const claims of refused) {
      expect((await signedForward(listTools, { claims })).status).toBe(403);
    }
    expect(mocks.findForwardedMember).not.toHaveBeenCalled();
  });

  it("refuses an assertion whose body hash does not match the request", async () => {
    const response = await signedForward(listTools, {
      rawBody: JSON.stringify({ id: 9, jsonrpc: "2.0", method: "tools/call", params: { name: "revoke_api_key" } }),
    });

    expect(response.status).toBe(403);
    expect(mocks.findForwardedMember).not.toHaveBeenCalled();
  });

  it("refuses a malformed assertion, project ID, email, or access", async () => {
    const malformedClaims: Claims[] = [
      { project: "not-a-uuid" },
      { email: "not an email" },
      { access: "admin" },
    ];
    for (const claims of malformedClaims) {
      expect((await signedForward(listTools, { claims })).status).toBe(403);
    }
    for (const value of ["", "a.b", "a.b.c", "not-an-assertion"]) {
      const response = await managementMcpRoutes.request("/", {
        body: JSON.stringify(listTools),
        headers: { "content-type": "application/json", "x-legacy-mcp-assertion": value },
        method: "POST",
      });
      expect(response.status).toBe(403);
    }
    const noneAlgorithm = await signedForward(listTools, {
      headers: {
        "x-legacy-mcp-assertion": `${base64url(JSON.stringify({ alg: "none" }))}.${base64url(JSON.stringify(claimsFor(JSON.stringify(listTools))))}.`,
      },
    });
    expect(noneAlgorithm.status).toBe(403);
    expect(mocks.findForwardedMember).not.toHaveBeenCalled();
  });

  it("accepts each assertion once", async () => {
    const response = await signedForward(listTools, { claims: { exp: now + 60, jti: "assertion-0000000001" } });

    expect(response.status).toBe(200);
    expect(mocks.claimAssertion).toHaveBeenCalledWith("assertion-0000000001", new Date((now + 90) * 1000));

    mocks.claimAssertion.mockResolvedValue(false);
    const replayed = await signedForward(listTools, { claims: { jti: "assertion-0000000001" } });

    expect(replayed.status).toBe(403);
    expect(mocks.claimAssertion).toHaveBeenCalledTimes(2);
    expect(mocks.claimAssertion).toHaveBeenLastCalledWith("assertion-0000000001", expect.any(Date));
    expect(mocks.findForwardedMember).toHaveBeenCalledTimes(1);
  });

  it("does not use up an assertion whose body does not match", async () => {
    await signedForward(listTools, { rawBody: "{}" });

    expect(mocks.claimAssertion).not.toHaveBeenCalled();
  });

  it("refuses a project that did not move here or a person who is not a member", async () => {
    mocks.findForwardedMember.mockResolvedValue(null);

    const response = await signedForward(listTools);

    expect(response.status).toBe(403);
    expect(mocks.findForwardedMember).toHaveBeenCalledWith(legacyProjectId, "Ash@Example.com");
  });
});
