/**
 * Operator CLI for pausing and resuming ingest for one organization.
 *
 * Pausing drops incoming events before an investigation is created, so a
 * paused organization produces no incidents, no notifications, and no model
 * spend. It deletes nothing and does not block sign-in, and `resume` restores
 * normal ingest.
 *
 *   pnpm ingest:status <organization-slug>
 *   pnpm ingest:pause  <organization-slug> --reason "..." --actor "..."
 *   pnpm ingest:resume <organization-slug> --actor "..."
 */
import { eq } from "drizzle-orm";
import { closeDatabase, getDatabase } from "../packages/core/src/db/client.js";
import {
  getOrganizationIngestPause,
  listOrganizationIngestPauses,
  pauseOrganizationIngest,
  resumeOrganizationIngest,
} from "../packages/core/src/db/organization-ingest.js";
import { organization } from "../packages/core/src/db/auth-schema.js";

type Command = "pause" | "resume" | "status";

function parseFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

async function resolveOrganization(slug: string) {
  const [record] = await getDatabase()
    .select({ id: organization.id, name: organization.name })
    .from(organization)
    .where(eq(organization.slug, slug))
    .limit(1);
  if (!record) throw new Error(`No organization with slug "${slug}"`);
  return record;
}

async function main() {
  const [command, slug, ...rest] = process.argv.slice(2);
  if (
    command !== "pause" &&
    command !== "resume" &&
    command !== "status"
  ) {
    throw new Error("Usage: <pause|resume|status> <organization-slug> [flags]");
  }
  if (!slug) throw new Error("An organization slug is required");

  const target = await resolveOrganization(slug);
  const label = `${target.name} (${slug})`;

  if ((command as Command) === "status") {
    const pause = await getOrganizationIngestPause(target.id);
    if (pause) {
      console.info(
        `${label}: ingest PAUSED since ${pause.pausedAt.toISOString()} by ${pause.pausedBy} — ${pause.reason}`,
      );
    } else {
      console.info(`${label}: ingest running`);
    }
    const history = await listOrganizationIngestPauses(target.id);
    for (const entry of history) {
      const resumed = entry.resumedAt
        ? `resumed ${entry.resumedAt.toISOString()} by ${entry.resumedBy}`
        : "open";
      console.info(
        `  ${entry.pausedAt.toISOString()} by ${entry.pausedBy} — ${entry.reason} (${resumed})`,
      );
    }
    return;
  }

  const actor = parseFlag(rest, "actor");
  if (!actor) throw new Error("--actor is required so the change is auditable");

  if ((command as Command) === "pause") {
    const reason = parseFlag(rest, "reason");
    if (!reason) throw new Error("--reason is required");
    const pause = await pauseOrganizationIngest({
      organizationId: target.id,
      pausedBy: actor,
      reason,
    });
    console.info(
      `${label}: ingest paused by ${pause.pausedBy} — ${pause.reason}`,
    );
    if (pause.pausedBy !== actor) {
      console.info("  (an earlier pause was already open and was kept)");
    }
    return;
  }

  const resumed = await resumeOrganizationIngest({
    organizationId: target.id,
    resumedBy: actor,
  });
  console.info(
    resumed
      ? `${label}: ingest resumed by ${actor}`
      : `${label}: ingest was already running; nothing to resume`,
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
