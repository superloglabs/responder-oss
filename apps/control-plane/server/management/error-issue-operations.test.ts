import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managementMcpRoutes } from "./mcp.js";
import { managementApiRoutes } from "./routes.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";
const apiKeyId = "31313131-3131-4131-8131-313131313131";
const issueId = "41414141-4141-4141-8141-414141414141";
const token = `slk_${"a".repeat(43)}`;

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  capability: vi.fn(),
  days: vi.fn(),
  find: vi.fn(),
  list: vi.fn(),
  setStatus: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/api-keys.js", () => ({
  authenticateApiKey: mocks.authenticate,
  listApiKeys: vi.fn().mockResolvedValue([]),
  revokeApiKey: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/oauth-access-tokens.js", () => ({
  authenticateOAuthAccessToken: vi.fn(),
}));
vi.mock("../../../../packages/core/src/db/organization-capabilities.js", () => ({
  listEnabledOrganizationCapabilities: vi.fn().mockResolvedValue([]),
  organizationHasCapability: mocks.capability,
}));
vi.mock("../../../../packages/core/src/db/error-issues.js", () => ({
  errorIssueDays: mocks.days,
  errorIssueServices: vi.fn(),
  errorIssueEnvironments: vi.fn(),
  errorIssueHours: vi.fn(),
  errorIssueStatusCounts: vi.fn(),
  findErrorIssue: mocks.find,
  listErrorIssues: mocks.list,
  setErrorIssueStatus: mocks.setStatus,
}));

const app = new Hono()
  .route("/api/v1", managementApiRoutes)
  .route("/api/mcp", managementMcpRoutes);

async function mcp(method: string, params?: Record<string, unknown>) {
  const response = await app.request("/api/mcp", {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, ...(params ? { params } : {}) }),
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  return ((await response.json()) as { result: Record<string, unknown> }).result;
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = await mcp("tools/call", { arguments: args, name }) as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  return { body: JSON.parse(result.content[0]!.text) as Record<string, unknown>, isError: result.isError };
}

const summary = {
  eventCount: 12,
  exceptionType: "TypeError",
  firstSeenAt: "2026-10-20T08:00:00.000Z",
  id: issueId,
  kind: "span",
  lastSeenAt: "2026-10-22T11:59:00.000Z",
  regressedAt: null,
  service: "api",
  status: "open",
  statusChangedAt: null,
  title: "TypeError: Cannot read properties of undefined",
  topFrame: "loadInvoice@apps/api/src/invoices.ts",
};
const issue = {
  ...summary,
  fingerprint: "v1:2e22350e88415f95",
  frames: ["loadInvoice@apps/api/src/invoices.ts"],
  lastSample: {
    attributes: {},
    kind: "span",
    message: "Cannot read properties of undefined",
    resourceAttributes: { "service.name": "api" },
    seenAt: summary.lastSeenAt,
    service: "api",
    severity: null,
    spanId: "b7ad6b7169203331",
    spanName: "GET /invoices/:id",
    stacktrace: "TypeError: Cannot read properties of undefined\n    at loadInvoice (apps/api/src/invoices.ts:40:12)",
    traceId: "0af7651916cd43dd8448eb211c80319c",
  },
  message: "Cannot read properties of undefined",
};

describe("error issue operations", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-22T12:00:00.000Z"), toFake: ["Date"] });
    mocks.authenticate.mockResolvedValue({
      apiKeyId,
      organizationId,
      role: "member",
      user: { email: "ash@example.com", id: userId, name: "Ash" },
    });
    mocks.capability.mockImplementation(async (_organization: string, capability: string) => capability === "telemetry");
    mocks.list.mockResolvedValue([summary]);
    mocks.find.mockResolvedValue(issue);
    mocks.days.mockResolvedValue(new Map([[issueId, [{ day: "2026-10-22", eventCount: 12 }]]]));
    mocks.setStatus.mockImplementation(async (_organization: string, _id: string, status: string) => ({ ...issue, status }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("lists the tools, with only status changes as a write", async () => {
    const { tools } = await mcp("tools/list") as {
      tools: Array<{ annotations: Record<string, unknown>; name: string }>;
    };
    const annotations = (name: string) => tools.find((tool) => tool.name === name)?.annotations;

    expect(annotations("list_error_issues")).toMatchObject({ readOnlyHint: true });
    expect(annotations("get_error_issue")).toMatchObject({ readOnlyHint: true });
    expect(annotations("update_error_issue")).toMatchObject({ readOnlyHint: false });
  });

  it("lists open issues by default, with a link to each", async () => {
    const { body } = await callTool("list_error_issues", { service: "api" });

    expect(body).toEqual({ issues: [{ ...summary, url: `http://localhost:3000/errors/${issueId}` }] });
    expect(mocks.list).toHaveBeenCalledWith(organizationId, { limit: 25, service: "api", status: "open" });
  });

  it("accepts a limit from a REST query string", async () => {
    const response = await app.request("/api/v1/error-issues?limit=50&status=all", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(organizationId, { limit: 50 });
  });

  it("returns an issue with its sample and 30 days of counts", async () => {
    const { body } = await callTool("get_error_issue", { issueId });

    expect(body).toEqual({
      issue: { ...issue, days: [{ day: "2026-10-22", eventCount: 12 }], url: `http://localhost:3000/errors/${issueId}` },
    });
    expect(mocks.days).toHaveBeenCalledWith([issueId], "2026-09-23");
  });

  it("resolves an issue", async () => {
    const { body } = await callTool("update_error_issue", { issueId, status: "resolved" });

    expect((body.issue as { status: string }).status).toBe("resolved");
    expect(mocks.setStatus).toHaveBeenCalledWith(organizationId, issueId, "resolved");
  });

  it("answers not found for another workspace's issue", async () => {
    mocks.find.mockResolvedValue(null);
    const { body, isError } = await callTool("get_error_issue", { issueId });

    expect(isError).toBe(true);
    expect(body).toMatchObject({ code: "error_issue_not_found" });
  });

  it("is not available without telemetry", async () => {
    mocks.capability.mockResolvedValue(false);
    const { body, isError } = await callTool("list_error_issues");

    expect(isError).toBe(true);
    expect(body).toMatchObject({ code: "telemetry_unavailable" });
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
