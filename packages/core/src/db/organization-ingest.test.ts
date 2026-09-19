import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { getDatabase } from "./client.js";
import {
  getIngestPauseForAgent,
  getOrganizationIngestPause,
  isOrganizationIngestPaused,
  pauseOrganizationIngest,
  resumeOrganizationIngest,
} from "./organization-ingest.js";

vi.mock("./client.js", () => ({ getDatabase: vi.fn() }));

const dialect = new PgDialect();

function renderSql(value: SQL | undefined): string {
  return value ? dialect.sqlToQuery(value).sql : "";
}

function selectQuery(rows: unknown[]) {
  const query = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    limit: vi.fn().mockResolvedValue(rows),
    orderBy: vi.fn().mockResolvedValue(rows),
  };
  query.from.mockReturnValue(query);
  query.innerJoin.mockReturnValue(query);
  query.where.mockReturnValue(query);
  return query;
}

function insertQuery() {
  const query = {
    values: vi.fn(),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
  };
  query.values.mockReturnValue(query);
  return query;
}

function updateQuery(rows: unknown[]) {
  const query = {
    set: vi.fn(),
    where: vi.fn(),
    returning: vi.fn().mockResolvedValue(rows),
  };
  query.set.mockReturnValue(query);
  query.where.mockReturnValue(query);
  return query;
}

const pauseRow = {
  organizationId: "org-1",
  pausedAt: new Date("2026-09-17T08:00:00.000Z"),
  pausedBy: "nicolo@superlog.sh",
  reason: "Runaway alert loop",
};

beforeEach(() => {
  vi.mocked(getDatabase).mockReset();
});

describe("organization ingest pauses", () => {
  it("reports an organization with an open pause as paused", async () => {
    const query = selectQuery([pauseRow]);
    vi.mocked(getDatabase).mockReturnValue({
      select: vi.fn().mockReturnValue(query),
    } as unknown as ReturnType<typeof getDatabase>);

    await expect(isOrganizationIngestPaused("org-1")).resolves.toBe(true);
  });

  it("reports an organization with no open pause as running", async () => {
    const query = selectQuery([]);
    vi.mocked(getDatabase).mockReturnValue({
      select: vi.fn().mockReturnValue(query),
    } as unknown as ReturnType<typeof getDatabase>);

    await expect(isOrganizationIngestPaused("org-1")).resolves.toBe(false);
  });

  it("ignores pauses that were already resumed", async () => {
    const query = selectQuery([]);
    vi.mocked(getDatabase).mockReturnValue({
      select: vi.fn().mockReturnValue(query),
    } as unknown as ReturnType<typeof getDatabase>);

    await getOrganizationIngestPause("org-1");

    // A resumed pause must not keep ingest blocked, so the lookup filters on a
    // null resumed_at as well as the organization.
    expect(renderSql(query.where.mock.calls[0]?.[0] as SQL)).toContain(
      '"resumed_at" is null',
    );
  });

  it("records the actor and reason when pausing", async () => {
    const insert = insertQuery();
    const select = selectQuery([pauseRow]);
    vi.mocked(getDatabase).mockReturnValue({
      insert: vi.fn().mockReturnValue(insert),
      select: vi.fn().mockReturnValue(select),
    } as unknown as ReturnType<typeof getDatabase>);

    await expect(
      pauseOrganizationIngest({
        organizationId: "org-1",
        pausedBy: "nicolo@superlog.sh",
        reason: "Runaway alert loop",
      }),
    ).resolves.toEqual(pauseRow);
    expect(insert.values).toHaveBeenCalledWith({
      organizationId: "org-1",
      pausedBy: "nicolo@superlog.sh",
      reason: "Runaway alert loop",
    });
  });

  it("keeps the original pause when an organization is paused twice", async () => {
    const insert = insertQuery();
    const select = selectQuery([pauseRow]);
    vi.mocked(getDatabase).mockReturnValue({
      insert: vi.fn().mockReturnValue(insert),
      select: vi.fn().mockReturnValue(select),
    } as unknown as ReturnType<typeof getDatabase>);

    const pause = await pauseOrganizationIngest({
      organizationId: "org-1",
      pausedBy: "someone-else@superlog.sh",
      reason: "Second pause",
    });

    expect(insert.onConflictDoNothing).toHaveBeenCalled();
    expect(pause.pausedBy).toBe("nicolo@superlog.sh");
    expect(pause.reason).toBe("Runaway alert loop");
  });

  it("rejects a pause without a reason", async () => {
    await expect(
      pauseOrganizationIngest({
        organizationId: "org-1",
        pausedBy: "nicolo@superlog.sh",
        reason: "   ",
      }),
    ).rejects.toThrow("A pause reason is required");
  });

  it("reports whether a resume actually lifted a pause", async () => {
    const update = updateQuery([{ id: "pause-1" }]);
    vi.mocked(getDatabase).mockReturnValue({
      update: vi.fn().mockReturnValue(update),
    } as unknown as ReturnType<typeof getDatabase>);

    await expect(
      resumeOrganizationIngest({
        organizationId: "org-1",
        resumedBy: "nicolo@superlog.sh",
      }),
    ).resolves.toBe(true);
    expect(update.set).toHaveBeenCalledWith(
      expect.objectContaining({ resumedBy: "nicolo@superlog.sh" }),
    );
  });

  it("reports a resume of a running organization as a no-op", async () => {
    const update = updateQuery([]);
    vi.mocked(getDatabase).mockReturnValue({
      update: vi.fn().mockReturnValue(update),
    } as unknown as ReturnType<typeof getDatabase>);

    await expect(
      resumeOrganizationIngest({
        organizationId: "org-1",
        resumedBy: "nicolo@superlog.sh",
      }),
    ).resolves.toBe(false);
  });

  it("resolves a pause from the agent handling an incoming event", async () => {
    const query = selectQuery([pauseRow]);
    vi.mocked(getDatabase).mockReturnValue({
      select: vi.fn().mockReturnValue(query),
    } as unknown as ReturnType<typeof getDatabase>);

    await expect(getIngestPauseForAgent("agent-1")).resolves.toEqual(pauseRow);
    // The join keeps the ingest check to a single indexed query.
    expect(query.innerJoin).toHaveBeenCalledTimes(1);
    expect(renderSql(query.innerJoin.mock.calls[0]?.[1] as SQL)).toContain(
      '"resumed_at" is null',
    );
  });

  it("lets events through for an agent whose organization is running", async () => {
    const query = selectQuery([]);
    vi.mocked(getDatabase).mockReturnValue({
      select: vi.fn().mockReturnValue(query),
    } as unknown as ReturnType<typeof getDatabase>);

    await expect(getIngestPauseForAgent("agent-1")).resolves.toBeNull();
  });
});
