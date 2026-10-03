import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  claimAutomationRun,
  findAutomationsForSlackEvent,
  findAutomationsForSentryIssue,
  findDueScheduledAutomations,
  summarizeAutomationList,
} from "./automations.js";
import { getDatabase } from "./client.js";
import { automationModelBrokerGrants } from "./schema.js";

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
    await expect(findAutomationsForSlackEvent({ authorIds: ["U1"], channelId: "C1", eventType: "message", teamId: "T1", text: "Checkout is down" }))
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

    await expect(findAutomationsForSlackEvent({ authorIds: ["U-DEVIN", "B-DEVIN", "A-DEVIN"], channelId: "C1", eventType: "message", teamId: "T1", text: "Agreed" }))
      .resolves.toEqual([{ automationId: "open", integrationAccountId: accountId, mentioned: false, startsRun: true }]);
    await expect(findAutomationsForSlackEvent({ authorIds: ["U-BOT", "B-RESPONDER"], channelId: "C1", eventType: "message", teamId: "T1", text: "Done" }))
      .resolves.toEqual([]);
    await expect(findAutomationsForSlackEvent({ authorIds: ["U1"], channelId: "C1", eventType: "message", teamId: "T1", text: "<@U-BOT> look" }))
      .resolves.toEqual([
        { automationId: "ignoring", integrationAccountId: accountId, mentioned: true, startsRun: true },
        { automationId: "open", integrationAccountId: accountId, mentioned: true, startsRun: true },
      ]);
  });

  it("matches an event against any of an automation's triggers", async () => {
    vi.mocked(getDatabase).mockReturnValue(queuedDatabase([[
      { accountId, automationId: "both", organizationId: "organization", triggers: [slack, sentry] },
      { accountId, automationId: "slack-only", organizationId: "organization", triggers: [slack] },
    ]]));
    await expect(findAutomationsForSentryIssue({ action: "unresolved", installationId: "installation", projectId: "web" }))
      .resolves.toEqual([{ automationId: "both", excludedEnvironments: [], integrationAccountId: accountId, organizationId: "organization" }]);
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
