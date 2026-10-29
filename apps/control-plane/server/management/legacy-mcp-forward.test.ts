import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managementMcpRoutes } from "./mcp.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";

const mocks = vi.hoisted(() => ({
  authenticateApiKey: vi.fn(),
  authenticateOAuth: vi.fn(),
  findMember: vi.fn(),
  getOrganizationSummary: vi.fn(),
  listCapabilities: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/legacy-mcp-forwarding.js", () => ({
  findLegacyMcpForwardMember: mocks.findMember,
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
      name: "Nautilus",
      slug: "nautilus",
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
