import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  claimAutomationRun,
  findAutomationsForSlackEvent,
  listSlackMessageAuthors,
  findAutomationsForAxiomAlert,
  findAutomationsForSentryIssue,
  findDueScheduledAutomations,
  getAutomationRunSlackButtons,
  listAutomationPullRequests,
  summarizeAutomationList,
} from "./automations.js";
import { getDatabase } from "./client.js";
import { automationActionAttempts, automationModelBrokerGrants } from "./schema.js";

vi.mock("./client.js", () => ({ getDatabase: vi.fn() }));

describe("summarizeAutomationList", () => {
  it("lists GitHub first, then context providers alphabetically", () => {
    const [row] = summarizeAutomationList(
      [{ id: "automation-1", versionId: "version-1" }],
      {
        accountRows: [
          { provider: "slack", versionId: "version-1" },
          { provider: "datadog", versionId: "version-1" },
          { provider: "sentry", versionId: "version-1" },
        ],
        repositoryRows: [{ versionId: "version-1" }],
        runRows: [],
      },
    );

    expect(row?.connectors).toEqual(["github", "datadog", "sentry", "slack"]);
  });

  it("lists skills after the providers, and for an automation that uses only skills", () => {
    const rows = summarizeAutomationList(
      [{ id: "automation-1", versionId: "version-1" }, { id: "automation-2", versionId: "version-2" }],
      {
        accountRows: [{ provider: "sentry", versionId: "version-1" }],
        repositoryRows: [{ versionId: "version-1" }],
        runRows: [],
        skillRows: [{ versionId: "version-1" }, { versionId: "version-2" }],
      },
    );

    expect(rows.map((row) => row.connectors)).toEqual([["github", "sentry", "skills"], ["skills"]]);
  });

  it("attaches connectors and the latest run to each automation", () => {
    const runAt = new Date("2026-09-24T10:00:00Z");
    const rows = summarizeAutomationList(
      [
        { id: "automation-1", name: "Errors", versionId: "version-1" },
        { id: "automation-2", name: "Docs", versionId: "version-2" },
      ],
      {
        accountRows: [
          { provider: "sentry", versionId: "version-1" },
          { provider: "datadog", versionId: "version-1" },
          { provider: "slack", versionId: "version-2" },
        ],
        repositoryRows: [{ versionId: "version-1" }],
        runRows: [{ automationId: "automation-1", createdAt: runAt, status: "failed" }],
      },
    );

    expect(rows).toEqual([
      {
        connectors: ["github", "datadog", "sentry"],
        id: "automation-1",
        lastRun: { createdAt: runAt, status: "failed" },
        name: "Errors",
      },
      { connectors: ["slack"], id: "automation-2", lastRun: null, name: "Docs" },
    ]);
  });
});

// Resolves each awaited query to the next queued result.
function queuedDatabase(results: unknown[][]) {
  const query = {
    from: () => query,
    innerJoin: () => query,
    where: () => query,
    then: (resolve: (rows: unknown[]) => unknown) => resolve(results.shift() ?? []),
  };
  return { select: () => query } as unknown as ReturnType<typeof getDatabase>;
}

describe("trigger matching", () => {
  const accountId = "41414141-4141-4141-8141-414141414141";
  const slack = { channelIds: ["C1"], eventMode: "mentions", integrationAccountId: accountId, kind: "slack" } as const;
  const sentry = { eventTypes: ["regression"], integrationAccountId: accountId, kind: "sentry", projectIds: ["web"] } as const;

  it("finds every automation watching a Slack channel and which ones the message starts", async () => {
    const everyMessage = { ...slack, eventMode: "every_message" } as const;
    const metadata = { appId: "A-RESPONDER", botUserId: "U-BOT" };
    vi.mocked(getDatabase).mockReturnValue(queuedDatabase([[
      { accountId, accountMetadata: metadata, automationId: "mentions", triggers: [slack] },
      { accountId, accountMetadata: metadata, automationId: "messages", triggers: [everyMessage] },
      { accountId, accountMetadata: metadata, automationId: "other-channel", triggers: [{ ...slack, channelIds: ["C9"] }] },
    ]]));

    // A plain message starts only "every message" automations, but a reply in
    // a run's thread reaches every automation watching the channel.
    await expect(findAutomationsForSlackEvent({ authorIds: ["U1"], channelId: "C1", eventType: "message", teamId: "T1", text: "Checkout is down", timestamp: "1790000000.000100" }))
      .resolves.toEqual([
        { automationId: "mentions", integrationAccountId: accountId, mentioned: false, startsRun: false },
        { automationId: "messages", integrationAccountId: accountId, mentioned: false, startsRun: true },
      ]);
  });

  it("skips the app's own messages and authors a trigger ignores", async () => {
    const metadata = { appId: "A-RESPONDER", botUserId: "U-BOT" };
    const ignoring = { ...slack, eventMode: "every_message", ignoredAuthors: [{ id: "A-DEVIN", name: "Devin" }] } as const;
    const rows = [
      { accountId, accountMetadata: metadata, automationId: "ignoring", triggers: [ignoring] },
      { accountId, accountMetadata: metadata, automationId: "open", triggers: [{ ...slack, eventMode: "every_message" }] },
    ];
    vi.mocked(getDatabase).mockReturnValue(queuedDatabase([rows, rows, rows]));

    await expect(findAutomationsForSlackEvent({ authorIds: ["U-DEVIN", "B-DEVIN", "A-DEVIN"], channelId: "C1", eventType: "message", teamId: "T1", text: "Agreed", timestamp: "1790000000.000100" }))
      .resolves.toEqual([{ automationId: "open", integrationAccountId: accountId, mentioned: false, startsRun: true }]);
    await expect(findAutomationsForSlackEvent({ authorIds: ["U-BOT", "B-RESPONDER"], channelId: "C1", eventType: "message", teamId: "T1", text: "Done", timestamp: "1790000000.000100" }))
      .resolves.toEqual([]);
    await expect(findAutomationsForSlackEvent({ authorIds: ["U1"], channelId: "C1", eventType: "message", teamId: "T1", text: "<@U-BOT> look", timestamp: "1790000000.000100" }))
      .resolves.toEqual([
        { automationId: "ignoring", integrationAccountId: accountId, mentioned: true, startsRun: true },
        { automationId: "open", integrationAccountId: accountId, mentioned: true, startsRun: true },
      ]);
  });

  it("starts a run on a thread reply only when it mentions the app", async () => {
    const metadata = { appId: "A-RESPONDER", botUserId: "U-BOT" };
    const automation = (automationId: string, eventMode: "both" | "every_message" | "mentions") => ({
      accountId,
      accountMetadata: metadata,
      automationId,
      organizationId: "organization",
      tagMode: false,
      tagModeThread: false,
      triggers: [{ ...slack, eventMode }],
    });
    const rows = [automation("messages", "every_message"), automation("mentions", "mentions"), automation("both", "both")];
    vi.mocked(getDatabase).mockReturnValue(queuedDatabase([rows, rows, rows, rows]));
    const startsRun = async (input: { eventType: "app_mention" | "message"; text: string; threadTimestamp?: string }) =>
      (await findAutomationsForSlackEvent({ authorIds: ["U1"], channelId: "C1", teamId: "T1", timestamp: "1790000000.000200", ...input }))
        .filter((match) => match.startsRun)
        .map((match) => match.automationId);

    // The first message of a thread is a new message.
    await expect(startsRun({ eventType: "message", text: "Checkout is down", threadTimestamp: "1790000000.000200" }))
      .resolves.toEqual(["messages", "both"]);
    // A reply that pings a teammate in a thread without a run starts nothing.
    await expect(startsRun({ eventType: "message", text: "<@U2> can you look?", threadTimestamp: "1790000000.000100" }))
      .resolves.toEqual([]);
    // A reply that mentions the app starts a run.
    await expect(startsRun({ eventType: "message", text: "<@U-BOT> can you look?", threadTimestamp: "1790000000.000100" }))
      .resolves.toEqual(["messages"]);
    await expect(startsRun({ eventType: "app_mention", text: "<@U-BOT> can you look?", threadTimestamp: "1790000000.000100" }))
      .resolves.toEqual(["mentions", "both"]);
  });

  it("starts a run on a thread reply also sent to the channel", async () => {
    const metadata = { appId: "A-RESPONDER", botUserId: "U-BOT" };
    const automation = (automationId: string, eventMode: "both" | "every_message" | "mentions", ignoredAuthors?: Array<{ id: string; name: string }>) => ({
      accountId,
      accountMetadata: metadata,
      automationId,
      organizationId: "organization",
      tagMode: false,
      tagModeThread: false,
      triggers: [{ ...slack, eventMode, ignoredAuthors }],
    });
    const rows = [
      automation("messages", "every_message"),
      automation("mentions", "mentions"),
      automation("both", "both"),
      automation("ignoring", "every_message", [{ id: "A-SENTRY", name: "Sentry" }]),
    ];
    vi.mocked(getDatabase).mockReturnValue(queuedDatabase([rows]));

    // Sentry posts a regression in the issue's thread and to the channel.
    const matches = await findAutomationsForSlackEvent({
      authorIds: ["B-SENTRY", "A-SENTRY"],
      broadcast: true,
      channelId: "C1",
      eventType: "message",
      teamId: "T1",
      text: "AutomationHarnessError State: Regressed",
      threadTimestamp: "1790000000.000100",
      timestamp: "1790000000.000200",
    });
    expect(matches.filter((match) => match.startsRun).map((match) => match.automationId)).toEqual(["messages", "both"]);
    expect(matches.map((match) => match.automationId)).toEqual(["messages", "mentions", "both"]);
  });

  it("starts a run only on messages from a trigger's included authors", async () => {
    const metadata = { appId: "A-RESPONDER", botUserId: "U-BOT" };
    const including = { ...slack, eventMode: "both", includedAuthors: [{ id: "A-SENTRY", name: "Sentry" }] } as const;
    const rows = [{ accountId, accountMetadata: metadata, automationId: "including", triggers: [including] }];
    vi.mocked(getDatabase).mockReturnValue(queuedDatabase([rows, rows, rows]));

    await expect(findAutomationsForSlackEvent({ authorIds: ["B-SENTRY", "A-SENTRY"], channelId: "C1", eventType: "message", teamId: "T1", text: "New issue", timestamp: "1790000000.000100" }))
      .resolves.toEqual([{ automationId: "including", integrationAccountId: accountId, mentioned: false, startsRun: true }]);
    // Anyone else, even with a mention, starts nothing, but a reply from them
    // in a run's thread still reaches the run.
    await expect(findAutomationsForSlackEvent({ authorIds: ["U1"], channelId: "C1", eventType: "message", teamId: "T1", text: "Checkout is down", timestamp: "1790000000.000100" }))
      .resolves.toEqual([{ automationId: "including", integrationAccountId: accountId, mentioned: false, startsRun: false }]);
    await expect(findAutomationsForSlackEvent({ authorIds: ["U1"], channelId: "C1", eventType: "app_mention", teamId: "T1", text: "<@U-BOT> look", timestamp: "1790000000.000100" }))
      .resolves.toEqual([{ automationId: "including", integrationAccountId: accountId, mentioned: true, startsRun: false }]);
  });

  it("leaves mentions and tag mode's threads to tag mode", async () => {
    const metadata = { appId: "A-RESPONDER", botUserId: "U-BOT" };
    const automation = (automationId: string, eventMode: "both" | "every_message" | "mentions", tagModeThread = false) => ({
      accountId,
      accountMetadata: metadata,
      automationId,
      organizationId: "organization",
      tagMode: true,
      tagModeThread,
      triggers: [{ ...slack, eventMode }],
    });
    const rows = [automation("messages", "every_message"), automation("mentions", "mentions"), automation("both", "both")];
    const threadRows = rows.map((row) => ({ ...row, tagModeThread: true }));
    const tagModeOffRows = threadRows.map((row) => ({ ...row, tagMode: false }));
    vi.mocked(getDatabase).mockReturnValue(queuedDatabase([rows, rows, rows, threadRows, tagModeOffRows]));
    const startsRun = async (input: { eventType: "app_mention" | "message"; text: string; threadTimestamp?: string }) =>
      (await findAutomationsForSlackEvent({ authorIds: ["U1"], channelId: "C1", teamId: "T1", timestamp: "1790000000.000200", ...input }))
        .filter((match) => match.startsRun)
        .map((match) => match.automationId);

    // A message that mentions the app starts only automations that watch for
    // mentions; tag mode answers it otherwise.
    await expect(startsRun({ eventType: "message", text: "Checkout is down" })).resolves.toEqual(["messages", "both"]);
    await expect(startsRun({ eventType: "message", text: "<@U-BOT> why is checkout down?" })).resolves.toEqual(["both"]);
    await expect(startsRun({ eventType: "app_mention", text: "<@U-BOT> why is checkout down?" })).resolves.toEqual(["mentions", "both"]);
    // No message in a thread tag mode answers in starts a run.
    await expect(startsRun({ eventType: "app_mention", text: "<@U-BOT> and now?", threadTimestamp: "1790000000.000100" }))
      .resolves.toEqual([]);
    // Once tag mode is off, its old threads start runs again.
    await expect(startsRun({ eventType: "app_mention", text: "<@U-BOT> and now?", threadTimestamp: "1790000000.000100" }))
      .resolves.toEqual(["mentions", "both"]);
  });

  it("lists each Slack author once, newest first, up to a limit", async () => {
    const calls: string[] = [];
    const query = {
      as: () => ({ lastSeenAt: "lastSeenAt" }),
      from: () => query,
      innerJoin: () => query,
      limit: (limit: number) => { calls.push(`limit ${limit}`); return query; },
      orderBy: () => query,
      where: () => query,
      then: (resolve: (rows: unknown[]) => unknown) => resolve([
        { id: "A-QOVERY", kind: "app", lastSeenAt: new Date("2026-10-03T12:00:00Z"), name: "Qovery" },
        { id: "U-ADA", kind: "person", lastSeenAt: new Date("2026-10-03T11:00:00Z"), name: "Ada" },
      ]),
    };
    // Each author's newest row, then the newest authors.
    const selectDistinctOn = vi.fn(() => { calls.push("distinct on author"); return query; });
    const select = vi.fn(() => { calls.push("select"); return query; });
    vi.mocked(getDatabase).mockReturnValue({ select, selectDistinctOn } as unknown as ReturnType<typeof getDatabase>);

    await expect(listSlackMessageAuthors({ channelIds: ["C1", "C2"], integrationAccountId: accountId, organizationId: "organization" }))
      .resolves.toEqual([
        { id: "A-QOVERY", kind: "app", name: "Qovery" },
        { id: "U-ADA", kind: "person", name: "Ada" },
      ]);
    expect(calls).toEqual(["distinct on author", "select", "limit 500"]);
  });

  it("matches an event against any of an automation's triggers", async () => {
    vi.mocked(getDatabase).mockReturnValue(queuedDatabase([[
      { accountId, automationId: "both", organizationId: "organization", triggers: [slack, sentry] },
      { accountId, automationId: "slack-only", organizationId: "organization", triggers: [slack] },
    ]]));
    await expect(findAutomationsForSentryIssue({ action: "unresolved", installationId: "installation", projectId: "web" }))
      .resolves.toEqual([{ automationId: "both", excludedEnvironments: [], integrationAccountId: accountId, organizationId: "organization" }]);
  });

  it("matches Axiom alerts to automations with an Axiom trigger on that connection", async () => {
    vi.mocked(getDatabase).mockReturnValue(queuedDatabase([[
      { automationId: "axiom", triggers: [slack, { integrationAccountId: accountId, kind: "axiom" }] },
      { automationId: "other-connection", triggers: [{ integrationAccountId: "00000000-0000-4000-8000-000000000099", kind: "axiom" }] },
      { automationId: "slack-only", triggers: [slack] },
    ]]));
    await expect(findAutomationsForAxiomAlert(accountId)).resolves.toEqual([{ automationId: "axiom" }]);
  });

  it("skips an environment only when every matching Sentry trigger excludes it", async () => {
    vi.mocked(getDatabase).mockReturnValue(queuedDatabase([[
      { accountId, automationId: "one", organizationId: "organization", triggers: [{ ...sentry, excludedEnvironments: ["dev", "staging"] }] },
      { accountId, automationId: "two", organizationId: "organization", triggers: [
        { ...sentry, excludedEnvironments: ["dev", "staging"] },
        { ...sentry, excludedEnvironments: ["staging"] },
      ] },
      { accountId, automationId: "open", organizationId: "organization", triggers: [{ ...sentry, excludedEnvironments: ["dev"] }, sentry] },
    ]]));
    await expect(findAutomationsForSentryIssue({ action: "unresolved", installationId: "installation", projectId: "web" }))
      .resolves.toEqual([
        { automationId: "one", excludedEnvironments: ["dev", "staging"], integrationAccountId: accountId, organizationId: "organization" },
        { automationId: "two", excludedEnvironments: ["staging"], integrationAccountId: accountId, organizationId: "organization" },
        { automationId: "open", excludedEnvironments: [], integrationAccountId: accountId, organizationId: "organization" },
      ]);
  });

  it("runs each due schedule slot once per automation", async () => {
    const now = new Date("2026-09-21T09:05:00Z");
    const daily = { frequency: "daily", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 } as const;
    const hourly = { ...daily, frequency: "hourly" } as const;
    vi.mocked(getDatabase).mockReturnValue(queuedDatabase([
      [{ automationId: "automation", triggers: [slack, daily, hourly], versionCreatedAt: new Date("2026-09-01T00:00:00Z") }],
      [],
    ]));
    await expect(findDueScheduledAutomations(now)).resolves.toEqual([
      { automationId: "automation", scheduledFor: new Date("2026-09-21T09:00:00Z"), trigger: daily },
    ]);
  });
});

describe("claimAutomationRun", () => {
  const runId = "96751171-8931-4f9b-aaea-098f400f93b2";
  const expiredLeaseId = "3400aa41-f315-4e0e-b9e0-9468832d98d8";

  function claimDatabase(current: Array<{ leaseId: string | null }>) {
    const deleted: Array<{ table: unknown; where: SQL }> = [];
    const update = vi.fn(() => ({
      set: () => ({
        where: () => ({
          returning: async () => [{
            automationId: "automation",
            automationVersionId: "version",
            leaseId: "new-lease",
            organizationId: "organization",
            sandboxSessionState: null,
            triggerInput: {},
          }],
        }),
      }),
    }));
    const tx = {
      delete: (table: unknown) => ({
        where: async (where: SQL) => {
          deleted.push({ table, where });
        },
      }),
      select: () => ({ from: () => ({ where: () => ({ for: async () => current }) }) }),
      update,
    };
    const configuration = {
      from: () => configuration,
      innerJoin: () => configuration,
      limit: async () => [{ harness: "codex", prompt: "Triage it" }],
      where: () => configuration,
    };
    vi.mocked(getDatabase).mockReturnValue({
      select: () => configuration,
      transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx),
    } as never);
    return { deleted, update };
  }

  it("removes the expired lease's broker grant before taking over the run", async () => {
    const { deleted, update } = claimDatabase([{ leaseId: expiredLeaseId }]);

    const run = await claimAutomationRun(runId);

    expect(run).toMatchObject({ prompt: "Triage it", runId });
    expect(run?.leaseId).not.toBe(expiredLeaseId);
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.table).toBe(automationModelBrokerGrants);
    const where = new PgDialect().sqlToQuery(deleted[0]!.where);
    expect(where.params).toEqual([runId, expiredLeaseId]);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("claims a pending run without touching grants", async () => {
    const { deleted, update } = claimDatabase([{ leaseId: null }]);

    await expect(claimAutomationRun(runId)).resolves.toMatchObject({ runId });
    expect(deleted).toHaveLength(0);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("leaves a run with a live lease alone", async () => {
    const { deleted, update } = claimDatabase([]);

    await expect(claimAutomationRun(runId)).resolves.toBeNull();
    expect(deleted).toHaveLength(0);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("getAutomationRunSlackButtons", () => {
  const runId = "96751171-8931-4f9b-aaea-098f400f93b2";
  const input = { channelId: "C1", messageTimestamp: "1790000001.000100", runId, teamId: "T1" };

  function buttonsDatabase(rows: unknown[]) {
    const conditions: SQL[] = [];
    const query = {
      from: () => query,
      innerJoin: () => query,
      limit: async () => rows,
      where: (where: SQL) => { conditions.push(where); return query; },
    };
    vi.mocked(getDatabase).mockReturnValue({ select: () => query } as never);
    return conditions;
  }

  it("looks up the run's message by channel, timestamp, and Slack workspace", async () => {
    const conditions = buttonsDatabase([{ automationEnabled: true, buttons: ["Create PR", "Ignore"], integrationAccountId: "account" }]);

    await expect(getAutomationRunSlackButtons(input)).resolves.toEqual({
      automationEnabled: true,
      buttons: ["Create PR", "Ignore"],
      integrationAccountId: "account",
    });
    const where = new PgDialect().sqlToQuery(conditions[0]!);
    expect(where.params).toEqual(expect.arrayContaining([runId, "send_slack_message", "succeeded", "C1:1790000001.000100", "slack", "T1"]));
  });

  it("finds nothing for a message without buttons", async () => {
    for (const buttons of [null, "Create PR", ["Create PR", 1]]) {
      buttonsDatabase([{ automationEnabled: true, buttons, integrationAccountId: "account" }]);
      await expect(getAutomationRunSlackButtons(input)).resolves.toBeNull();
    }
    buttonsDatabase([]);
    await expect(getAutomationRunSlackButtons(input)).resolves.toBeNull();
  });
});

describe("listAutomationPullRequests", () => {
  it("dates and orders pull requests by when they were opened, not when the first attempt started", async () => {
    const selections: Array<Record<string, unknown>> = [];
    const orders: unknown[][] = [];
    const query = {
      from: () => query,
      innerJoin: () => query,
      limit: () => query,
      offset: async () => [],
      orderBy: (...columns: unknown[]) => { orders.push(columns); return query; },
      then: (resolve: (rows: unknown[]) => void) => resolve([{ total: "0" }]),
      where: () => query,
    };
    vi.mocked(getDatabase).mockReturnValue({
      select: (selection: Record<string, unknown>) => { selections.push(selection); return query; },
    } as never);

    await listAutomationPullRequests("organization", { limit: 25, offset: 0 });

    expect(selections[0]?.openedAt).toBe(automationActionAttempts.updatedAt);
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(orders[0]![0] as SQL).sql).toContain('"updated_at" desc');
  });
});
