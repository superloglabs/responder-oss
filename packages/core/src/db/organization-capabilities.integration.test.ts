import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { organization } from "./auth-schema.js";
import { closeDatabase, getDatabase } from "./client.js";
import { listTelemetryOrganizationIds, organizationReceivesTelemetry } from "./organization-capabilities.js";
import { organizationCapabilities, type OrganizationCapability } from "./schema.js";

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_ORGANIZATION_CAPABILITIES_DATABASE_URL;
describe.skipIf(!testUrl)("organization capabilities (PostgreSQL)", () => {
  const workspaces = {
    automationsOnly: randomUUID(),
    signal: randomUUID(),
    signalOff: randomUUID(),
    telemetry: randomUUID(),
  };
  const grants: Array<[string, OrganizationCapability, boolean]> = [
    [workspaces.automationsOnly, "automations", true],
    [workspaces.signal, "signal", true],
    [workspaces.signalOff, "signal", false],
    [workspaces.telemetry, "telemetry", true],
  ];

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!);
    vi.stubEnv("DATABASE_POOL_SIZE", "2");
    const createdAt = new Date("2026-11-09T12:00:00.000Z");
    await getDatabase().insert(organization).values(
      Object.entries(workspaces).map(([name, id]) => ({ createdAt, id, name, slug: id })),
    );
    await getDatabase().insert(organizationCapabilities).values(
      grants.map(([organizationId, capability, enabled]) => ({ capability, enabled, organizationId })),
    );
  });
  afterAll(async () => {
    await getDatabase().delete(organization).where(inArray(organization.id, Object.values(workspaces)));
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  it("lets Signal workspaces receive telemetry without the telemetry product", async () => {
    expect(await organizationReceivesTelemetry(workspaces.telemetry)).toBe(true);
    expect(await organizationReceivesTelemetry(workspaces.signal)).toBe(true);
    expect(await organizationReceivesTelemetry(workspaces.signalOff)).toBe(false);
    expect(await organizationReceivesTelemetry(workspaces.automationsOnly)).toBe(false);

    const receiving = await listTelemetryOrganizationIds();
    expect(receiving).toEqual(expect.arrayContaining([workspaces.telemetry, workspaces.signal]));
    expect(receiving).not.toContain(workspaces.signalOff);
    expect(receiving).not.toContain(workspaces.automationsOnly);
  });
});
