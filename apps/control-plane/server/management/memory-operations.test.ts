import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryImportPrompt } from "../../src/memory-import.js";
import { managementMcpRoutes } from "./mcp.js";
import { managementApiRoutes } from "./routes.js";

const organizationId = "15151515-1515-4515-8515-151515151515";
const userId = "21212121-2121-4121-8121-212121212121";
const apiKeyId = "31313131-3131-4131-8131-313131313131";
const memoryId = "41414141-4141-4141-8141-414141414141";
const token = `slk_${"a".repeat(43)}`;

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  capability: vi.fn(),
  delete: vi.fn(),
  get: vi.fn(),
  import: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
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
vi.mock("../../../../packages/core/src/db/workspace-memories.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  deleteWorkspaceMemory: mocks.delete,
  getWorkspaceMemory: mocks.get,
  importWorkspaceMemories: mocks.import,
  listWorkspaceMemories: mocks.list,
  updateWorkspaceMemory: mocks.update,
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

const regions = {
  body: "The EU cell runs in eu-west-3 and the US cell in us-east-1.",
  description: "Where each production cell runs",
  name: "production-regions",
  type: "project",
};

const stored = {
  ...regions,
  id: memoryId,
  updatedAt: new Date("2026-11-03T10:00:00.000Z"),
  updatedBy: { id: userId, name: "Ash" },
};

describe("memory operations", () => {
  beforeEach(() => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");
    mocks.authenticate.mockResolvedValue({
      apiKeyId,
      organizationId,
      role: "member",
      user: { email: "ash@example.com", id: userId, name: "Ash" },
    });
    mocks.capability.mockImplementation(async (_organization: string, capability: string) => capability === "automations");
    mocks.get.mockResolvedValue(stored);
    mocks.update.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("marks importing as a write and changing or deleting as destructive", async () => {
    const { tools } = await mcp("tools/list") as {
      tools: Array<{ annotations: Record<string, unknown>; name: string }>;
    };
    const annotations = (name: string) => tools.find((tool) => tool.name === name)?.annotations;

    expect(annotations("list_memories")).toMatchObject({ readOnlyHint: true });
    expect(annotations("get_memory")).toMatchObject({ readOnlyHint: true });
    expect(annotations("import_memories")).toMatchObject({ destructiveHint: false, readOnlyHint: false });
    expect(annotations("update_memory")).toMatchObject({ destructiveHint: true });
    expect(annotations("delete_memory")).toMatchObject({ destructiveHint: true });
  });

  it("imports new memories as the caller and lists names that already exist", async () => {
    mocks.import.mockResolvedValue({ created: [{ id: memoryId, name: "production-regions" }], existing: ["worker-hangs"] });

    const { body, isError } = await callTool("import_memories", {
      memories: [
        { body: regions.body, description: regions.description, name: regions.name },
        { body: "Restart the worker.", description: "Worker hangs after RDS restarts", name: "worker-hangs", type: "feedback" },
      ],
    });

    expect(isError).toBeFalsy();
    expect(body).toEqual({
      created: [{ id: memoryId, name: "production-regions" }],
      existing: ["worker-hangs"],
      url: "https://responder.example/memory",
    });
    expect(mocks.import).toHaveBeenCalledWith({
      memories: [
        regions,
        { body: "Restart the worker.", description: "Worker hangs after RDS restarts", name: "worker-hangs", type: "feedback" },
      ],
      organizationId,
      userId,
    });
  });

  it("refuses a batch that names one memory twice", async () => {
    const { body, isError } = await callTool("import_memories", { memories: [regions, regions] });

    expect(isError).toBe(true);
    expect(body).toMatchObject({ code: "invalid_request" });
    expect(mocks.import).not.toHaveBeenCalled();
  });

  it("reports memories that look like they contain credentials", async () => {
    const { WorkspaceMemoryError } = await import("../../../../packages/core/src/db/workspace-memories.js");
    mocks.import.mockRejectedValue(new WorkspaceMemoryError("These memories look like they contain credentials: db (a URL with a password).", "credential"));

    expect(await callTool("import_memories", { memories: [regions] })).toMatchObject({
      body: { code: "credential", error: expect.stringContaining("db (a URL with a password)") },
      isError: true,
    });
  });

  it("changes only the fields sent", async () => {
    const { body, isError } = await callTool("update_memory", { body: "The EU cell runs in eu-west-3.", memoryId });

    expect(isError).toBeFalsy();
    expect(mocks.update).toHaveBeenCalledWith({
      memory: { ...regions, body: "The EU cell runs in eu-west-3." },
      memoryId,
      organizationId,
      userId,
    });
    expect(body).toMatchObject({ memory: { id: memoryId, url: `https://responder.example/memory/${memoryId}` } });
  });

  it("returns a missing memory as not found", async () => {
    mocks.get.mockResolvedValue(null);
    mocks.delete.mockResolvedValue(false);

    expect(await callTool("get_memory", { memoryId })).toMatchObject({ body: { code: "memory_not_found" }, isError: true });
    expect(await callTool("update_memory", { description: "New", memoryId })).toMatchObject({ body: { code: "memory_not_found" }, isError: true });
    expect(await callTool("delete_memory", { memoryId })).toMatchObject({ body: { code: "memory_not_found" }, isError: true });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  // The Memory page gives people this prompt for their coding agent.
  it("names only tools the server offers in the import prompt", async () => {
    const { tools } = await mcp("tools/list") as { tools: Array<{ name: string }> };
    const named = [...memoryImportPrompt.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/gu)].map(([name]) => name);

    expect(named).toEqual(expect.arrayContaining(["list_memories", "import_memories", "update_memory"]));
    expect(named.filter((name) => !tools.some((tool) => tool.name === name))).toEqual([]);
  });

  it("is not available without automations", async () => {
    mocks.capability.mockResolvedValue(false);

    expect(await callTool("list_memories")).toMatchObject({ body: { code: "automations_unavailable" }, isError: true });
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
