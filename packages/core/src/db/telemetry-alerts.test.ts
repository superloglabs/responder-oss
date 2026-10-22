import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { findTelemetryAlertActivation } from "./telemetry-alerts.js";
const database = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("./client.js", () => ({ getDatabase: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => database.rows }) }) }) }) }));

describe("telemetry alerts", () => {
  const migration = readFileSync(new URL("../../../../drizzle/0078_telemetry_alerts.sql", import.meta.url), "utf8");

  it("keeps at most one open episode per alert and group", () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "telemetry_alert_episodes_open_idx" ON "telemetry_alert_episodes" USING btree ("alert_id","group_key") WHERE "telemetry_alert_episodes"."state" = \'firing\'',
    );
  });

  it("removes alerts with their workspace, and stops posting and replying when the Slack connection is removed", () => {
    expect(migration).toMatch(/"telemetry_alerts_organization_id_organization_id_fk" FOREIGN KEY \("organization_id"\) REFERENCES "public"\."organization"\("id"\) ON DELETE cascade/u);
    for (const table of ["telemetry_alerts", "telemetry_alert_episodes"]) {
      expect(migration).toMatch(
        new RegExp(
          `ALTER TABLE "${table}" ADD CONSTRAINT "[^"]+" FOREIGN KEY \\("slack_integration_account_id"\\) REFERENCES "public"\\."integration_accounts"\\("id"\\) ON DELETE set null`,
          "u",
        ),
      );
    }
  });
});


describe("activation delivery history", () => {
  const at = new Date("2026-10-22T10:00:00Z");
  const row = { id: "episode", groupKey: "", state: "resolved", startedAt: at, endedAt: at,
    openValue: 60, peakValue: 80, lastValue: 10, ruleSnapshot: null,
    endReason: "recovered", slackChannelId: "C1", slackMessageTs: "1792663200.000001",
    slackIntegrationAccountId: "account", recoveryNotifiedAt: at };

  it("reports a confirmed recovery delivery", async () => {
    database.rows = [row];
    expect(await findTelemetryAlertActivation("alert", "episode")).toMatchObject({ recoveryNotifiedAt: at.toISOString() });
  });

  it("does not turn a skipped recovery into a delivered notification", async () => {
    for (const change of [{ endReason: "configuration_changed" }, { endReason: null }, { slackMessageTs: null }, { slackIntegrationAccountId: null }]) {
      database.rows = [{ ...row, ...change }];
      expect(await findTelemetryAlertActivation("alert", "episode")).toMatchObject({ recoveryNotifiedAt: null });
    }
  });

  it("keeps a legacy snapshot unknown, and handles a missing activation", async () => {
    database.rows = [row];
    expect(await findTelemetryAlertActivation("alert", "episode")).toMatchObject({ ruleSnapshot: null });
    database.rows = [];
    expect(await findTelemetryAlertActivation("alert", "missing")).toBeNull();
  });
});
