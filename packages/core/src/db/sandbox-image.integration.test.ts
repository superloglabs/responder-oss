import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSandboxImageSettings } from "../sandbox-image.js";
import { organization } from "./auth-schema.js";
import { closeDatabase, getDatabase } from "./client.js";
import {
  getSandboxImageRequestedAt,
  getSandboxImageSettings,
  listSandboxImageWorkspaces,
  saveSandboxImageSettings,
} from "./sandbox-image.js";
import { sandboxImageSettings } from "./schema.js";

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_SANDBOX_IMAGE_DATABASE_URL;
describe.skipIf(!testUrl)("sandbox image settings (PostgreSQL)", () => {
  const organizationId = randomUUID();

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!);
    vi.stubEnv("DATABASE_POOL_SIZE", "4");
    await getDatabase().insert(organization).values({
      createdAt: new Date(),
      id: organizationId,
      name: "Sandbox image test",
      slug: organizationId,
    });
  });
  beforeEach(async () => {
    await getDatabase()
      .delete(sandboxImageSettings)
      .where(eq(sandboxImageSettings.organizationId, organizationId));
  });
  afterAll(async () => {
    await getDatabase().delete(organization).where(eq(organization.id, organizationId));
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  it("leaves dependency installs off for a workspace without settings", async () => {
    expect(await getSandboxImageSettings(organizationId)).toEqual(defaultSandboxImageSettings);
  });

  it("saves dependency installs without asking for an image", async () => {
    await saveSandboxImageSettings(
      organizationId,
      { ...defaultSandboxImageSettings, installDependencies: true },
      null,
      false,
    );

    expect(await getSandboxImageSettings(organizationId)).toEqual({
      ...defaultSandboxImageSettings,
      installDependencies: true,
    });
    expect(await getSandboxImageRequestedAt(organizationId)).toBeNull();
    // A workspace that only installs dependencies has no image to maintain.
    expect((await listSandboxImageWorkspaces()).map((workspace) => workspace.organizationId))
      .not.toContain(organizationId);

    await saveSandboxImageSettings(organizationId, defaultSandboxImageSettings, null, false);
    expect((await getSandboxImageSettings(organizationId)).installDependencies).toBe(false);
  });
});
