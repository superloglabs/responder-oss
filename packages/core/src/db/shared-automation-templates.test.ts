import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDatabase } from "./client.js";
import { shareAutomation, unshareAutomation } from "./shared-automation-templates.js";

vi.mock("./client.js", () => ({ getDatabase: vi.fn() }));

const organizationId = "15151515-1515-4515-8515-151515151515";
const automationId = "31313131-3131-4131-8131-313131313131";
const userId = "21212121-2121-4121-8121-212121212121";

// Resolves each awaited select to the next queued result and records the
// insert so tests can read what was written.
function fakeDatabase(selects: unknown[][], returned: (values: Record<string, unknown>) => unknown) {
  const writes: Array<{ values: Record<string, unknown>; set: Record<string, unknown> }> = [];
  const wheres: SQL[] = [];
  const query = {
    from: () => query,
    innerJoin: () => query,
    limit: () => query,
    where: (condition: SQL) => { wheres.push(condition); return query; },
    then: (resolve: (rows: unknown[]) => unknown) => resolve(selects.shift() ?? []),
  };
  let values: Record<string, unknown> = {};
  const insert = {
    values: (next: Record<string, unknown>) => { values = next; return insert; },
    onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => { writes.push({ set, values }); return insert; },
    returning: () => Promise.resolve([returned(values)]),
  };
  const deleted = {
    where: (condition: SQL) => { wheres.push(condition); return deleted; },
    returning: () => Promise.resolve([{ id: "share" }]),
  };
  vi.mocked(getDatabase).mockReturnValue({
    delete: () => deleted,
    insert: () => insert,
    select: () => query,
  } as unknown as ReturnType<typeof getDatabase>);
  return { wheres, writes };
}

describe("shared automation templates", () => {
  beforeEach(() => vi.mocked(getDatabase).mockReset());

  it("does not share an automation outside the organization", async () => {
    const { wheres, writes } = fakeDatabase([[]], () => ({}));

    await expect(shareAutomation({ automationId, organizationId, userId })).resolves.toBeNull();
    expect(writes).toEqual([]);
    expect(new PgDialect().sqlToQuery(wheres[0]!).params).toEqual([automationId, organizationId]);
  });

  it("snapshots the automation as it is, without workspace identifiers", async () => {
    const triggers = [
      { eventTypes: ["new_issue"], integrationAccountId: "41414141-4141-4141-8141-414141414141", kind: "sentry", projectIds: ["web"] },
    ];
    const { writes } = fakeDatabase(
      [[{ description: "Posts a summary", id: "version-1", name: "Triage", prompt: "Rate the issue.", triggers }], [{ provider: "slack" }, { provider: "sentry" }], [{ id: "repository-1" }]],
      (values) => ({ slug: values.slug }),
    );

    const result = await shareAutomation({ automationId, organizationId, userId });

    expect(result?.created).toBe(true);
    expect(writes[0]!.values).toMatchObject({
      description: "Posts a summary",
      name: "Triage",
      prompt: "Rate the issue.",
      automationId,
      connectors: ["github", "slack"],
      createdBy: userId,
      organizationId,
      triggers: [{ eventTypes: ["new_issue"], integrationAccountId: "", kind: "sentry", projectIds: [] }],
    });
    expect(writes[0]!.values.slug).toMatch(/^[A-Za-z0-9_-]{16}$/u);
    // Sharing again replaces the snapshot and keeps the existing link.
    expect(writes[0]!.set).not.toHaveProperty("slug");
    expect(writes[0]!.set).not.toHaveProperty("organizationId");
  });

  it("reports an update when the automation was already shared", async () => {
    fakeDatabase(
      [[{ description: "", id: "version-1", name: "Triage", prompt: "Rate it.", triggers: [] }], [], []],
      () => ({ slug: "existingSlug0000" }),
    );

    const result = await shareAutomation({ automationId, organizationId, userId });

    expect(result).toMatchObject({ created: false, share: { slug: "existingSlug0000" } });
  });

  it("scopes unsharing to the organization", async () => {
    const { wheres } = fakeDatabase([], () => ({}));

    await expect(unshareAutomation(organizationId, automationId)).resolves.toBe(true);
    expect(new PgDialect().sqlToQuery(wheres[0]!).params).toEqual([automationId, organizationId]);
  });
});
