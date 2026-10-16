import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SuggestedAutomationTemplate } from "../automations/suggested-templates.js";
import {
  finishAutomationSuggestionRefill,
  getLatestAutomationSuggestions,
  removeAutomationSuggestions,
  startAutomationSuggestionRefill,
} from "./automation-template-suggestions.js";
import { getDatabase } from "./client.js";

vi.mock("./client.js", () => ({ getDatabase: vi.fn() }));

const organizationId = "15151515-1515-4515-8515-151515151515";
const now = new Date("2026-10-16T09:00:00.000Z");

function template(id: string, name = `Suggestion ${id}`): SuggestedAutomationTemplate {
  return {
    category: "scans",
    connectors: [],
    description: "Each Monday, list flaky tests.",
    id,
    name,
    prompt: "List flaky tests.",
    reason: "You have CI.",
    triggers: [{ frequency: "weekly", hour: 9, kind: "schedule", timezone: "UTC", weekday: 1 }],
  };
}

interface Row {
  generatedOn: string;
  refillRequestedAt: Date | null;
  refills: number;
  removedTemplateIds: string[];
  templates: SuggestedAutomationTemplate[];
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    generatedOn: "2026-10-16",
    refillRequestedAt: null,
    refills: 0,
    removedTemplateIds: [],
    templates: [template("a"), template("b"), template("c")],
    ...overrides,
  };
}

// Every select reads the one stored row; updates are recorded.
function fakeDatabase(stored: Row | null) {
  const updates: Array<Record<string, unknown>> = [];
  const query = {
    for: () => query,
    from: () => query,
    limit: () => query,
    orderBy: () => query,
    where: () => query,
    then: (resolve: (rows: unknown[]) => unknown) => resolve(stored ? [stored] : []),
  };
  const update = {
    set: (values: Record<string, unknown>) => { updates.push(values); return update; },
    where: () => Promise.resolve(),
  };
  const database = { select: () => query, update: () => update };
  vi.mocked(getDatabase).mockReturnValue({
    ...database,
    transaction: (run: (tx: typeof database) => Promise<unknown>) => run(database),
  } as unknown as ReturnType<typeof getDatabase>);
  return { updates };
}

describe("automation template suggestion refills", () => {
  beforeEach(() => vi.mocked(getDatabase).mockReset());

  it("shows the latest day without removed suggestions", async () => {
    fakeDatabase(row({ refillRequestedAt: new Date(now.getTime() - 60_000), removedTemplateIds: ["b"] }));

    await expect(getLatestAutomationSuggestions(organizationId, now)).resolves.toEqual({
      canRefresh: true,
      generatedOn: "2026-10-16",
      refreshing: true,
      templates: [template("a"), template("c")],
    });
  });

  it("stops showing a refill as running after three minutes", async () => {
    fakeDatabase(row({ refillRequestedAt: new Date(now.getTime() - 3 * 60_000), refills: 10 }));

    await expect(getLatestAutomationSuggestions(organizationId, now)).resolves.toMatchObject({
      canRefresh: false,
      refreshing: false,
    });
  });

  it("hides a dismissed suggestion and requests a replacement", async () => {
    const { updates } = fakeDatabase(row({ refills: 2 }));

    const removal = await removeAutomationSuggestions({ now, organizationId, templateIds: ["b"] });

    expect(updates).toEqual([expect.objectContaining({ refillRequestedAt: now, refills: 3, removedTemplateIds: ["b"] })]);
    expect(removal).toMatchObject({
      kind: "removed",
      refillRequested: true,
      suggestions: { refreshing: true, templates: [template("a"), template("c")] },
    });
  });

  it("ignores a suggestion that is not shown", async () => {
    const { updates } = fakeDatabase(row({ removedTemplateIds: ["b"] }));

    await expect(removeAutomationSuggestions({ now, organizationId, templateIds: ["b"] })).resolves.toEqual({ kind: "none" });
    expect(updates).toEqual([]);
  });

  it("still hides a suggestion when the day has no replacements left", async () => {
    const { updates } = fakeDatabase(row({ refills: 10 }));

    const removal = await removeAutomationSuggestions({ now, organizationId, templateIds: ["a"] });

    expect(updates).toEqual([expect.objectContaining({ refillRequestedAt: null, refills: 10, removedTemplateIds: ["a"] })]);
    expect(removal).toMatchObject({ kind: "removed", refillRequested: false });
  });

  it("refreshes every shown suggestion, but not past the day's limit", async () => {
    const { updates } = fakeDatabase(row({ removedTemplateIds: ["a"] }));

    await expect(removeAutomationSuggestions({ now, organizationId, templateIds: "all" })).resolves.toMatchObject({
      kind: "removed",
      suggestions: { refreshing: true, templates: [] },
    });
    expect(updates[0]).toMatchObject({ removedTemplateIds: ["a", "b", "c"] });

    const limited = fakeDatabase(row({ refills: 10 }));
    await expect(removeAutomationSuggestions({ now, organizationId, templateIds: "all" })).resolves.toMatchObject({ kind: "limit" });
    expect(limited.updates).toEqual([]);
  });

  it("refreshes when every suggestion was already removed", async () => {
    const { updates } = fakeDatabase(row({ removedTemplateIds: ["a", "b", "c"] }));

    await expect(removeAutomationSuggestions({ now, organizationId, templateIds: "all" })).resolves.toMatchObject({ kind: "removed", refillRequested: true });
    expect(updates[0]).toMatchObject({ refillRequestedAt: now, removedTemplateIds: ["a", "b", "c"] });
  });

  it("counts the suggestions a refill has to write", async () => {
    fakeDatabase(row({ refillRequestedAt: now, removedTemplateIds: ["a", "c"] }));
    await expect(startAutomationSuggestionRefill({ generatedOn: "2026-10-16", organizationId })).resolves.toEqual({ missing: 2, requestedAt: now });

    fakeDatabase(row());
    await expect(startAutomationSuggestionRefill({ generatedOn: "2026-10-16", organizationId })).resolves.toBeNull();
  });

  it("adds replacements up to three shown and closes the request it answered", async () => {
    const { updates } = fakeDatabase(row({ refillRequestedAt: now, removedTemplateIds: ["a"] }));

    await finishAutomationSuggestionRefill({
      generatedOn: "2026-10-16",
      organizationId,
      requestedAt: now,
      templates: [template("d"), template("e")],
    });

    expect(updates[0]).toMatchObject({
      refillRequestedAt: null,
      templates: [template("a"), template("b"), template("c"), template("d")],
    });
  });

  it("keeps a newer request open for the job that answers it", async () => {
    const later = new Date(now.getTime() + 5_000);
    const { updates } = fakeDatabase(row({ refillRequestedAt: later, removedTemplateIds: ["a", "b"] }));

    await finishAutomationSuggestionRefill({ generatedOn: "2026-10-16", organizationId, requestedAt: now, templates: [template("d")] });

    expect(updates[0]).toMatchObject({ refillRequestedAt: later });
  });
});
