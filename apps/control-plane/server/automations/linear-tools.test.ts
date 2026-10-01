import { describe, expect, it, vi } from "vitest";
import type { AutomationContextBrokerClaim } from "../../../../packages/core/src/db/automation-model-broker.js";
import {
  callLinearTool,
  linearIdentifierFromUrl,
  linearToolDefinitions,
} from "./linear-tools.js";

const runId = "21212121-2121-4121-8121-212121212121";
const attemptId = "31313131-3131-4131-8131-313131313131";
const issueUrl = "https://linear.app/acme/issue/OPS-42/checkout-returns-503";

const claim: AutomationContextBrokerClaim = {
  account: {
    encryptedCredentials: null,
    externalAccountId: "linear-workspace",
    id: "61616161-6161-4161-8161-616161616161",
    metadata: {},
    provider: "linear",
  },
  organizationId: "15151515-1515-4515-8515-151515151515",
  resources: [],
  roles: ["context"],
  runId,
  trigger: {},
};

function dependencies() {
  return {
    appendEvent: vi.fn().mockResolvedValue(1),
    beginAttempt: vi.fn().mockResolvedValue({ id: attemptId, status: "started" }),
    callTool: vi.fn().mockResolvedValue({ content: [{ text: "[]", type: "text" }] }),
    completeAttempt: vi.fn().mockResolvedValue(undefined),
    createIssue: vi.fn().mockResolvedValue({ id: attemptId, identifier: "OPS-42", url: issueUrl }),
    failAttempt: vi.fn().mockResolvedValue(undefined),
    findIssue: vi.fn().mockResolvedValue(null),
    listTools: vi.fn().mockResolvedValue([
      { annotations: { readOnlyHint: true }, inputSchema: { type: "object" }, name: "list_users" },
      { inputSchema: { type: "object" }, name: "list_issues" },
      { annotations: { readOnlyHint: false }, inputSchema: { type: "object" }, name: "update_issue" },
    ]),
  };
}

const createArgs = {
  assignee_id: "user-1",
  description: "The checkout route throws for missing carts.",
  label_ids: ["label-bug"],
  priority: 2,
  team_id: "team-ops",
  title: "Checkout returns 503",
};

function call(deps: ReturnType<typeof dependencies>, name: string, args: unknown) {
  return callLinearTool({ accessToken: "linear-token", args, claim, dependencies: deps, name });
}

describe("automation Linear tools", () => {
  it("lists Linear's read tools and the broker's create_issue tool", async () => {
    const deps = dependencies();

    const tools = await linearToolDefinitions("linear-token", deps);

    expect(tools.map((tool) => tool.name)).toEqual(["list_users", "list_issues", "create_issue"]);
    expect(deps.listTools).toHaveBeenCalledWith({ accessToken: "linear-token" });
  });

  it("forwards read tools to Linear's read-only endpoint", async () => {
    const deps = dependencies();

    const result = await call(deps, "list_users", { query: "ash" });

    expect(result).toEqual({ content: [{ text: "[]", type: "text" }] });
    expect(deps.callTool).toHaveBeenCalledWith({
      accessToken: "linear-token",
      arguments: { query: "ash" },
      name: "list_users",
    });
  });

  it("creates an assigned issue under the attempt ID and records it", async () => {
    const deps = dependencies();

    const result = await call(deps, "create_issue", createArgs);

    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ identifier: "OPS-42", url: issueUrl });
    expect(deps.createIssue).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: "linear-token",
      assigneeId: "user-1",
      id: attemptId,
      labelIds: ["label-bug"],
      priority: 2,
      teamId: "team-ops",
      title: "Checkout returns 503",
    }));
    expect(deps.beginAttempt).toHaveBeenCalledWith(expect.objectContaining({
      kind: "create_linear_issue",
      redactedInput: { assigneeId: "user-1", teamId: "team-ops", title: "Checkout returns 503" },
      runId,
    }));
    expect(deps.completeAttempt).toHaveBeenCalledWith({ attemptId, externalReference: issueUrl });
    expect(deps.appendEvent).toHaveBeenCalledWith({
      data: { externalReference: issueUrl, kind: "create_linear_issue", title: "Checkout returns 503" },
      runId,
      type: "action_succeeded",
    });
  });

  it("returns the issue already created for the same team and title", async () => {
    const deps = dependencies();
    deps.beginAttempt.mockResolvedValue({ externalReference: issueUrl, id: attemptId, status: "existing_succeeded" });

    const result = await call(deps, "create_issue", createArgs);

    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      identifier: "OPS-42",
      note: "This issue was already created in this run.",
    });
    expect(deps.createIssue).not.toHaveBeenCalled();
  });

  it("finds an issue an earlier failed attempt already created", async () => {
    const deps = dependencies();
    deps.createIssue.mockRejectedValue(new Error("Entity already exists"));
    deps.findIssue.mockResolvedValue({ id: attemptId, identifier: "OPS-42", url: issueUrl });

    const result = await call(deps, "create_issue", createArgs);

    expect(result.isError).toBeUndefined();
    expect(deps.findIssue).toHaveBeenCalledWith({ accessToken: "linear-token", issueId: attemptId });
    expect(deps.completeAttempt).toHaveBeenCalledWith({ attemptId, externalReference: issueUrl });
  });

  it("returns Linear errors to the agent and records the failed attempt", async () => {
    const deps = dependencies();
    deps.createIssue.mockRejectedValue(new Error("Argument Validation Error"));

    const result = await call(deps, "create_issue", createArgs);

    expect(result).toEqual({
      content: [{ text: "Linear did not create the issue: Argument Validation Error", type: "text" }],
      isError: true,
    });
    expect(deps.failAttempt).toHaveBeenCalledWith({ attemptId, failureMessage: "Argument Validation Error" });
  });

  it("rejects invalid arguments without writing", async () => {
    const deps = dependencies();

    await expect(call(deps, "create_issue", { ...createArgs, priority: 9 })).resolves.toMatchObject({ isError: true });
    await expect(call(deps, "create_issue", { title: "No team" })).resolves.toMatchObject({ isError: true });
    expect(deps.beginAttempt).not.toHaveBeenCalled();
  });

  it("reads the identifier from a Linear issue URL", () => {
    expect(linearIdentifierFromUrl(issueUrl)).toBe("OPS-42");
    expect(linearIdentifierFromUrl("https://linear.app/acme/issue/OPS-42")).toBe("OPS-42");
    expect(linearIdentifierFromUrl("https://linear.app/acme/project/x")).toBeNull();
  });
});
