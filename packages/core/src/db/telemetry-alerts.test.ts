import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
    expect(migration).not.toContain('REFERENCES "public"."telemetry_projects"');
  });
});
