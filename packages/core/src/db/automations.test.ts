import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  claimAutomationRun,
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

  it("matches an event against any of an automation's triggers", async () => {
    vi.mocked(getDatabase).mockReturnValue(queuedDatabase([[
      { accountId, automationId: "both", triggers: [slack, sentry] },
      { accountId, automationId: "slack-only", triggers: [slack] },
    ]]));
    await expect(findAutomationsForSentryIssue({ action: "unresolved", installationId: "installation", projectId: "web" }))
      .resolves.toEqual([{ automationId: "both" }]);
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
