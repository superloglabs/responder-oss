import { AutomationIssueRunLinkedError } from "@responder/core/db/automation-issues";
import { describe, expect, it, vi } from "vitest";
import { callWorkspaceTool } from "./workspace-tools.js";
import {
  createIssueCatalog,
  issueCatalogInstructions,
  usesIssueCatalog,
  type IssueCatalogDependencies,
} from "./issue-catalog.js";

vi.mock("@responder/core/db/automation-issues", async (importOriginal) => ({
  ...await importOriginal<typeof import("@responder/core/db/automation-issues")>(),
  appendAutomationIssueRecords: vi.fn(),
  attachAutomationIssue: vi.fn(),
  fileAutomationIssue: vi.fn(),
  listAutomationIssueCandidates: vi.fn(),
  listRecentAutomationRuns: vi.fn(),
  searchAutomationIssuesByText: vi.fn(),
}));

const automationId = "10000000-0000-4000-8000-000000000000";
const organizationId = "20000000-0000-4000-8000-000000000000";
const runId = "30000000-0000-4000-8000-000000000000";
const issueId = "40000000-0000-4000-8000-000000000000";
const otherIssueId = "50000000-0000-4000-8000-000000000000";
const catalogScope = { automationId, organizationId };
const scope = { ...catalogScope, runId };

function issue(id = issueId, title = "US sync checks time out") {
  return {
    firstSeenAt: new Date("2026-10-12T06:02:00.000Z"),
    id,
    lastSeenAt: new Date("2026-10-12T06:28:00.000Z"),
    links: [],
    occurrences: 3,
    slackMessages: [],
    summary: "Hourly validation checks in usnv return 504.",
    title,
  };
}

function dependencies(): { [K in keyof IssueCatalogDependencies]: ReturnType<typeof vi.fn> } & IssueCatalogDependencies {
  return {
    append: vi.fn().mockResolvedValue(undefined),
    attach: vi.fn().mockResolvedValue({ attached: true, issue: issue() }),
    embed: vi.fn().mockResolvedValue({ model: "openai/text-embedding-3-small", vector: [1, 0] }),
    file: vi.fn().mockResolvedValue({ issue: issue(), status: "filed" }),
    listCandidates: vi.fn().mockResolvedValue([]),
    listRuns: vi.fn().mockResolvedValue({ runs: [], total: 0 }),
    now: () => new Date("2026-10-12T06:30:00.000Z"),
    searchText: vi.fn().mockResolvedValue([]),
  } as never;
}

async function call(catalog: ReturnType<typeof createIssueCatalog>, name: string, args: unknown) {
  const spec = catalog.tools.find((tool) => tool.name === name)!;
  const result = await callWorkspaceTool(spec, args);
  const text = result.content[0]!.text;
  return { isError: result.isError === true, value: result.isError ? text : JSON.parse(text) };
}

describe("issue catalog", () => {
  it("is used by the first turn of an alert run that reports to Slack", () => {
    const sentry = { provider: "sentry" };
    expect(usesIssueCatalog({ firstTurn: true, notificationChannels: 1, triggerInput: sentry })).toBe(true);
    expect(usesIssueCatalog({ firstTurn: true, notificationChannels: 1, triggerInput: { provider: "signoz" } })).toBe(true);
    expect(usesIssueCatalog({ firstTurn: false, notificationChannels: 1, triggerInput: sentry })).toBe(false);
    expect(usesIssueCatalog({ firstTurn: true, notificationChannels: 0, triggerInput: sentry })).toBe(false);
    expect(usesIssueCatalog({ firstTurn: true, notificationChannels: 1, triggerInput: { provider: "schedule" } })).toBe(false);
    expect(usesIssueCatalog({ firstTurn: true, notificationChannels: 1, triggerInput: { provider: "slack" } })).toBe(false);
  });

  it("tells the agent to attach repeats and let the earliest run report a stream", () => {
    const instructions = issueCatalogInstructions();
    expect(instructions).toContain("call attach_issue with its id, then call skip_notification");
    expect(instructions).toContain("The earliest run reports for all of them.");
    expect(instructions).toContain("Defer only to runs that are pending or running, or that filed an issue");
    expect(instructions).toContain("titleContains");
    expect(instructions).toContain("laterRunIds");
  });

  it("finds issues by similarity first, then by text", async () => {
    const deps = dependencies();
    deps.listCandidates.mockResolvedValue([
      { ...issue(otherIssueId, "Pool timeouts"), embedding: [0, 1], embeddingModel: "openai/text-embedding-3-small" },
      { ...issue(), embedding: [1, 0.1], embeddingModel: "openai/text-embedding-3-small" },
      { ...issue("60000000-0000-4000-8000-000000000000"), embedding: [1, 0], embeddingModel: "older-model" },
    ]);
    deps.searchText.mockResolvedValue([issue(), issue("70000000-0000-4000-8000-000000000000", "504 in usnv")]);
    const catalog = createIssueCatalog(scope, deps);

    const { value } = await call(catalog, "find_issues", { query: "504 from sync validation" });

    expect(deps.embed).toHaveBeenCalledWith("504 from sync validation");
    expect(deps.listCandidates).toHaveBeenCalledWith(catalogScope);
    expect(value.issues.map((found: { id: string }) => found.id)).toEqual([
      issueId,
      otherIssueId,
      "70000000-0000-4000-8000-000000000000",
    ]);
    expect(value.issues[0]).toMatchObject({
      firstSeenAt: "2026-10-12T06:02:00.000Z",
      occurrences: 3,
      similarity: 0.995,
      title: "US sync checks time out",
    });
    expect(value.issues[2]).not.toHaveProperty("similarity");
  });

  it("keeps text matches when similar issues fill the page", async () => {
    const deps = dependencies();
    deps.listCandidates.mockResolvedValue(Array.from({ length: 12 }, (_, index) => ({
      ...issue(`9000000${index.toString(16)}-0000-4000-8000-000000000000`, `Similar ${index}`),
      embedding: [1, index / 100],
      embeddingModel: "openai/text-embedding-3-small",
    })));
    deps.searchText.mockResolvedValue([issue(issueId, "Not embedded")]);
    const catalog = createIssueCatalog(scope, deps);

    const { value } = await call(catalog, "find_issues", { query: "Not embedded" });

    expect(value.issues).toHaveLength(10);
    expect(value.issues.at(-1)).toMatchObject({ id: issueId, title: "Not embedded" });
  });

  it("searches by text when the query cannot be embedded", async () => {
    const deps = dependencies();
    deps.embed.mockResolvedValue(null);
    deps.searchText.mockResolvedValue([issue()]);
    const catalog = createIssueCatalog(scope, deps);

    const { value } = await call(catalog, "find_issues", { query: "504" });

    expect(value.issues).toHaveLength(1);
    expect(value.issues[0].id).toBe(issueId);
  });

  it("files an issue counting the later runs and records the run's post on it", async () => {
    const deps = dependencies();
    const catalog = createIssueCatalog(scope, deps);
    await catalog.recordAction({ externalReference: "C0123:1791787772.000100", kind: "send_slack_message" });
    expect(deps.append).not.toHaveBeenCalled();

    const { value } = await call(catalog, "file_issue", {
      laterRunIds: ["80000000-0000-4000-8000-000000000000", "80000000-0000-4000-8000-000000000001"],
      links: [{ url: "https://linear.app/example/issue/SYNC-4101" }],
      summary: "Hourly validation checks in usnv return 504.",
      title: "US sync checks time out",
    });

    expect(deps.embed).toHaveBeenCalledWith("US sync checks time out\n\nHourly validation checks in usnv return 504.");
    expect(deps.file).toHaveBeenCalledWith({
      ...scope,
      embedding: { model: "openai/text-embedding-3-small", vector: [1, 0] },
      laterRunIds: ["80000000-0000-4000-8000-000000000000", "80000000-0000-4000-8000-000000000001"],
      links: [{ url: "https://linear.app/example/issue/SYNC-4101" }],
      summary: "Hourly validation checks in usnv return 504.",
      title: "US sync checks time out",
    });
    expect(value).toMatchObject({ filed: true, issue: { id: issueId } });
    expect(deps.append).toHaveBeenCalledWith({
      issueId,
      links: [],
      slackMessages: [{ channelId: "C0123", timestamp: "1791787772.000100" }],
    });

    await catalog.recordAction({
      externalReference: "https://github.com/example/app/pull/7",
      kind: "open_github_pull_request",
      title: "Retry validation checks",
    });
    expect(deps.append).toHaveBeenLastCalledWith({
      issueId,
      links: [{ label: "Retry validation checks", url: "https://github.com/example/app/pull/7" }],
      slackMessages: [],
    });
  });

  it("tells a run that an earlier run already reported its problem", async () => {
    const deps = dependencies();
    deps.file.mockResolvedValue({ issue: issue(), status: "attached_by_earlier_run" });
    const catalog = createIssueCatalog(scope, deps);

    const { isError, value } = await call(catalog, "file_issue", { summary: "A summary.", title: "A title" });

    expect(isError).toBe(false);
    expect(value).toMatchObject({ alreadyReported: true, issue: { id: issueId } });
    expect(value.note).toContain("call skip_notification");
  });

  it("accepts only web links", async () => {
    const deps = dependencies();
    const catalog = createIssueCatalog(scope, deps);

    for (const url of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd"]) {
      const { isError } = await call(catalog, "file_issue", { links: [{ url }], summary: "A summary.", title: "A title" });
      expect(isError).toBe(true);
    }
    expect(deps.file).not.toHaveBeenCalled();
  });

  it("does not record a pull request link twice", async () => {
    const deps = dependencies();
    const url = "https://github.com/example/app/pull/7";
    deps.file.mockResolvedValue({ issue: { ...issue(), links: [{ url }] }, status: "filed" });
    const catalog = createIssueCatalog(scope, deps);
    await catalog.recordAction({ externalReference: url, kind: "open_github_pull_request", title: "Retry checks" });

    await call(catalog, "file_issue", { links: [{ url }], summary: "A summary.", title: "A title" });
    await catalog.recordAction({ externalReference: url, kind: "open_github_pull_request", title: "Retry checks" });

    expect(deps.append).not.toHaveBeenCalled();
  });

  it("files an issue without later runs", async () => {
    const deps = dependencies();
    const catalog = createIssueCatalog(scope, deps);

    await call(catalog, "file_issue", { summary: "A summary.", title: "A title" });

    expect(deps.file.mock.calls[0]![0]).toMatchObject({ laterRunIds: [], links: [] });
  });

  it("attaches the run to an existing issue", async () => {
    const deps = dependencies();
    const catalog = createIssueCatalog(scope, deps);

    const { value } = await call(catalog, "attach_issue", { issueId });

    expect(deps.attach).toHaveBeenCalledWith({ ...scope, issueId });
    expect(value).toMatchObject({ attached: true, issue: { id: issueId } });
  });

  it("explains an attach the catalog cannot make", async () => {
    const deps = dependencies();
    deps.attach.mockResolvedValueOnce(null);
    deps.attach.mockRejectedValueOnce(new AutomationIssueRunLinkedError(otherIssueId));
    const catalog = createIssueCatalog(scope, deps);

    const missing = await call(catalog, "attach_issue", { issueId });
    const linked = await call(catalog, "attach_issue", { issueId });

    expect(missing).toEqual({ isError: true, value: "No issue with that id is in this automation's catalog." });
    expect(linked).toEqual({ isError: true, value: `This run is already linked to issue ${otherIssueId}.` });
  });

  it("filters runs by title and always shows this run", async () => {
    const deps = dependencies();
    const current = {
      completedAt: null,
      createdAt: new Date("2026-10-12T06:05:00.000Z"),
      id: runId,
      issueId: null,
      relationship: null,
      startedAt: null,
      status: "running",
      title: "SYNCS-SCHEDULERS-5AA: Error 504: for task_id: 1a4f41da",
    };
    deps.listRuns.mockResolvedValue({
      current,
      runs: [{ ...current, createdAt: new Date("2026-10-12T06:02:00.000Z"), id: "80000000-0000-4000-8000-000000000000" }],
      total: 207,
    });
    const catalog = createIssueCatalog(scope, deps);

    const { value } = await call(catalog, "list_runs", { titleContains: "Error 504" });

    expect(deps.listRuns.mock.calls[0]![0]).toMatchObject({ currentRunId: runId, titleContains: "Error 504" });
    expect(value.total).toBe(207);
    expect(value.runs.map((run: { id: string }) => run.id)).toEqual(["80000000-0000-4000-8000-000000000000", runId]);
    expect(value.runs[1]).toMatchObject({ current: true });
  });

  it("lists the automation's recent runs and marks this one", async () => {
    const deps = dependencies();
    deps.listRuns.mockResolvedValue({
      runs: [
        {
          completedAt: null,
          createdAt: new Date("2026-10-12T06:02:00.000Z"),
          id: "80000000-0000-4000-8000-000000000000",
          issueId: null,
          relationship: null,
          startedAt: new Date("2026-10-12T06:02:05.000Z"),
          status: "running",
          title: "SYNCS-SCHEDULERS-4YB: Error 504: for task_id: bf177469",
        },
        {
          completedAt: null,
          createdAt: new Date("2026-10-12T06:02:30.000Z"),
          id: runId,
          issueId: null,
          relationship: null,
          startedAt: null,
          status: "running",
          title: "SYNCS-SCHEDULERS-4YD: Error 504: for task_id: 8e72fcb0",
        },
      ],
      total: 150,
    });
    const catalog = createIssueCatalog(scope, deps);

    const { value } = await call(catalog, "list_runs", {});

    expect(deps.listRuns).toHaveBeenCalledWith({
      ...catalogScope,
      currentRunId: runId,
      finishedSince: new Date("2026-10-12T06:00:00.000Z"),
      limit: 100,
      titleContains: null,
    });
    expect(value).toEqual({
      currentRunId: runId,
      notListed: 148,
      total: 150,
      runs: [
        {
          createdAt: "2026-10-12T06:02:00.000Z",
          id: "80000000-0000-4000-8000-000000000000",
          startedAt: "2026-10-12T06:02:05.000Z",
          status: "running",
          title: "SYNCS-SCHEDULERS-4YB: Error 504: for task_id: bf177469",
        },
        {
          createdAt: "2026-10-12T06:02:30.000Z",
          current: true,
          id: runId,
          status: "running",
          title: "SYNCS-SCHEDULERS-4YD: Error 504: for task_id: 8e72fcb0",
        },
      ],
    });
  });
});
