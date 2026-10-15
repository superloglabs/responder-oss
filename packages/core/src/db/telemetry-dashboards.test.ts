import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("telemetry dashboards", () => {
  const migration = readFileSync(
    new URL("../../../../drizzle/0077_telemetry_dashboards.sql", import.meta.url),
    "utf8",
  );

  it("removes dashboards with their workspace and widgets with their dashboard", () => {
    expect(migration).toMatch(
      /"telemetry_dashboards_organization_id_organization_id_fk" FOREIGN KEY \("organization_id"\) REFERENCES "public"\."organization"\("id"\) ON DELETE cascade/u,
    );
    expect(migration).toMatch(
      /FOREIGN KEY \("dashboard_id"\) REFERENCES "public"\."telemetry_dashboards"\("id"\) ON DELETE cascade/u,
    );
  });
});
