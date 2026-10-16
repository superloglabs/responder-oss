import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import {
  suggestedAutomationTemplateCount,
  type AutomationSuggestionContext,
  type SuggestedAutomationTemplate,
} from "../automations/suggested-templates.js";
import { organization, session } from "./auth-schema.js";
import { getDatabase } from "./client.js";
import {
  automations,
  automationTemplateSuggestions,
  integrationAccounts,
  issues,
  organizationCapabilities,
  repositories,
} from "./schema.js";

const maxAttempts = 3;
// A worker that stopped while generating leaves the row `generating`; another
// worker takes the day over after this long.
const staleGenerationMs = 30 * 60 * 1_000;
const keptDays = 14;
// Replacements a workspace can ask for per day. Each one is a model call.
const maxRefills = 10;
// A refill the worker has not finished by then is shown as done, so the
// gallery stops waiting for it.
const refillTimeoutMs = 3 * 60 * 1_000;

// The UTC day a set of suggestions belongs to, such as 2026-10-16.
export function automationSuggestionDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// A day is open to generate when it has no row, or its row failed or went
// stale and has attempts left.
function retryableDay(now: Date) {
  return and(
    lt(automationTemplateSuggestions.attempts, maxAttempts),
    or(
      eq(automationTemplateSuggestions.status, "failed"),
      and(
        eq(automationTemplateSuggestions.status, "generating"),
        lt(automationTemplateSuggestions.updatedAt, new Date(now.getTime() - staleGenerationMs)),
      ),
    ),
  );
}

// The opposite of `retryableDay`: ready, out of attempts, or generating now.
function settledDay(now: Date) {
  return or(
    eq(automationTemplateSuggestions.status, "ready"),
    gte(automationTemplateSuggestions.attempts, maxAttempts),
    and(
      eq(automationTemplateSuggestions.status, "generating"),
      gte(automationTemplateSuggestions.updatedAt, new Date(now.getTime() - staleGenerationMs)),
    ),
  );
}

// Organizations with automations and at least one repository that a member
// used in the last week, which have no suggestions for the day yet. Without a
// repository the model has nothing specific to suggest from. Operator
// impersonation does not count as use.
export async function listOrganizationsDueForAutomationSuggestions(input: {
  activeSince: Date;
  day: string;
  limit: number;
  now: Date;
}): Promise<string[]> {
  const db = getDatabase();
  const active = db
    .selectDistinct({ organizationId: session.activeOrganizationId })
    .from(session)
    .where(and(gt(session.updatedAt, input.activeSince), isNull(session.impersonatedBy)));
  const withRepositories = db
    .selectDistinct({ organizationId: integrationAccounts.organizationId })
    .from(repositories)
    .innerJoin(integrationAccounts, eq(repositories.integrationAccountId, integrationAccounts.id))
    .where(and(eq(integrationAccounts.status, "connected"), eq(repositories.available, true)));
  const done = db
    .select({ organizationId: automationTemplateSuggestions.organizationId })
    .from(automationTemplateSuggestions)
    .where(and(eq(automationTemplateSuggestions.generatedOn, input.day), settledDay(input.now)));
  const rows = await db
    .select({ id: organizationCapabilities.organizationId })
    .from(organizationCapabilities)
    .where(and(
      eq(organizationCapabilities.capability, "automations"),
      eq(organizationCapabilities.enabled, true),
      inArray(sql`${organizationCapabilities.organizationId}::text`, active),
      inArray(organizationCapabilities.organizationId, withRepositories),
      notInArray(organizationCapabilities.organizationId, done),
    ))
    .limit(input.limit);
  return rows.map((row) => row.id);
}

// Claims the organization's day for this worker. Returns false when another
// worker holds it or it is already done.
export async function claimAutomationSuggestionDay(input: {
  day: string;
  now: Date;
  organizationId: string;
}): Promise<boolean> {
  const rows = await getDatabase()
    .insert(automationTemplateSuggestions)
    .values({ generatedOn: input.day, organizationId: input.organizationId, status: "generating", updatedAt: input.now })
    .onConflictDoUpdate({
      set: {
        attempts: sql`${automationTemplateSuggestions.attempts} + 1`,
        error: null,
        status: "generating",
        updatedAt: input.now,
      },
      setWhere: retryableDay(input.now),
      target: [automationTemplateSuggestions.organizationId, automationTemplateSuggestions.generatedOn],
    })
    .returning({ organizationId: automationTemplateSuggestions.organizationId });
  return rows.length > 0;
}

export async function completeAutomationSuggestionDay(input: {
  day: string;
  organizationId: string;
  templates: SuggestedAutomationTemplate[];
}): Promise<void> {
  await getDatabase()
    .update(automationTemplateSuggestions)
    .set({ error: null, status: "ready", templates: input.templates, updatedAt: new Date() })
    .where(and(
      eq(automationTemplateSuggestions.organizationId, input.organizationId),
      eq(automationTemplateSuggestions.generatedOn, input.day),
    ));
}

export async function failAutomationSuggestionDay(input: {
  day: string;
  error: string;
  organizationId: string;
}): Promise<void> {
  await getDatabase()
    .update(automationTemplateSuggestions)
    .set({ error: input.error.slice(0, 2_000), status: "failed", updatedAt: new Date() })
    .where(and(
      eq(automationTemplateSuggestions.organizationId, input.organizationId),
      eq(automationTemplateSuggestions.generatedOn, input.day),
    ));
}

export async function deleteOldAutomationSuggestions(now: Date): Promise<void> {
  const oldest = automationSuggestionDay(new Date(now.getTime() - keptDays * 24 * 60 * 60 * 1_000));
  await getDatabase()
    .delete(automationTemplateSuggestions)
    .where(lt(automationTemplateSuggestions.generatedOn, oldest));
}

export interface LatestAutomationSuggestions {
  // False once the day's replacements are used up.
  canRefresh: boolean;
  generatedOn: string;
  // True while the worker writes replacements.
  refreshing: boolean;
  templates: SuggestedAutomationTemplate[];
}

type SuggestionRow = Pick<
  typeof automationTemplateSuggestions.$inferSelect,
  "generatedOn" | "refillRequestedAt" | "refills" | "removedTemplateIds" | "templates"
>;

const suggestionRowColumns = {
  generatedOn: automationTemplateSuggestions.generatedOn,
  refillRequestedAt: automationTemplateSuggestions.refillRequestedAt,
  refills: automationTemplateSuggestions.refills,
  removedTemplateIds: automationTemplateSuggestions.removedTemplateIds,
  templates: automationTemplateSuggestions.templates,
};

function shownTemplates(row: SuggestionRow): SuggestedAutomationTemplate[] {
  const removed = new Set(row.removedTemplateIds);
  return row.templates.filter((template) => !removed.has(template.id));
}

function presentSuggestions(row: SuggestionRow, now: Date): LatestAutomationSuggestions {
  return {
    canRefresh: row.refills < maxRefills,
    generatedOn: row.generatedOn,
    refreshing: row.refillRequestedAt !== null && now.getTime() - row.refillRequestedAt.getTime() < refillTimeoutMs,
    templates: shownTemplates(row),
  };
}

function latestReadyDay(organizationId: string) {
  return and(
    eq(automationTemplateSuggestions.organizationId, organizationId),
    eq(automationTemplateSuggestions.status, "ready"),
  );
}

// The newest ready suggestions, without the ones members used or dismissed.
// A failed or generating day shows the previous day's set.
export async function getLatestAutomationSuggestions(
  organizationId: string,
  now = new Date(),
): Promise<LatestAutomationSuggestions | null> {
  const rows = await getDatabase()
    .select(suggestionRowColumns)
    .from(automationTemplateSuggestions)
    .where(latestReadyDay(organizationId))
    .orderBy(desc(automationTemplateSuggestions.generatedOn))
    .limit(1);
  return rows[0] ? presentSuggestions(rows[0], now) : null;
}

export type AutomationSuggestionRemoval =
  | { kind: "removed"; refillRequested: boolean; suggestions: LatestAutomationSuggestions }
  | { kind: "limit"; suggestions: LatestAutomationSuggestions }
  | { kind: "none" };

// Hides suggestions a member used or dismissed and, while the day has
// replacements left, asks the worker for new ones. `"all"` hides every shown
// suggestion for a refresh, and asks for new ones even when none are shown.
// With no replacements left it changes nothing, so a refresh never empties
// the section.
export async function removeAutomationSuggestions(input: {
  now: Date;
  organizationId: string;
  templateIds: string[] | "all";
}): Promise<AutomationSuggestionRemoval> {
  return getDatabase().transaction(async (tx) => {
    const [row] = await tx
      .select(suggestionRowColumns)
      .from(automationTemplateSuggestions)
      .where(latestReadyDay(input.organizationId))
      .orderBy(desc(automationTemplateSuggestions.generatedOn))
      .limit(1)
      .for("update");
    if (!row) return { kind: "none" };
    const shownIds = shownTemplates(row).map((template) => template.id);
    const removing = input.templateIds === "all"
      ? shownIds
      : shownIds.filter((id) => input.templateIds.includes(id));
    const refresh = input.templateIds === "all";
    if (!removing.length && !refresh) return { kind: "none" };
    const refill = row.refills < maxRefills;
    if (refresh && !refill) return { kind: "limit", suggestions: presentSuggestions(row, input.now) };
    const next: SuggestionRow = {
      ...row,
      refillRequestedAt: refill ? input.now : row.refillRequestedAt,
      refills: refill ? row.refills + 1 : row.refills,
      removedTemplateIds: [...row.removedTemplateIds, ...removing],
    };
    await tx
      .update(automationTemplateSuggestions)
      .set({
        refillRequestedAt: next.refillRequestedAt,
        refills: next.refills,
        removedTemplateIds: next.removedTemplateIds,
        updatedAt: input.now,
      })
      .where(and(
        eq(automationTemplateSuggestions.organizationId, input.organizationId),
        eq(automationTemplateSuggestions.generatedOn, row.generatedOn),
      ));
    return { kind: "removed", refillRequested: refill, suggestions: presentSuggestions(next, input.now) };
  });
}

// What a refill job has to write: how many suggestions are missing, and the
// request it answers. Null when nothing was requested.
export async function startAutomationSuggestionRefill(input: {
  generatedOn: string;
  organizationId: string;
}): Promise<{ missing: number; requestedAt: Date } | null> {
  const [row] = await getDatabase()
    .select(suggestionRowColumns)
    .from(automationTemplateSuggestions)
    .where(and(
      eq(automationTemplateSuggestions.organizationId, input.organizationId),
      eq(automationTemplateSuggestions.generatedOn, input.generatedOn),
    ))
    .limit(1);
  if (!row?.refillRequestedAt) return null;
  return {
    missing: Math.max(0, suggestedAutomationTemplateCount - shownTemplates(row).length),
    requestedAt: row.refillRequestedAt,
  };
}

// Adds replacements up to three shown suggestions. The request stays open
// when a member asked again while the model was writing; the job queued for
// that request answers it.
export async function finishAutomationSuggestionRefill(input: {
  generatedOn: string;
  organizationId: string;
  requestedAt: Date;
  templates: SuggestedAutomationTemplate[];
}): Promise<void> {
  await getDatabase().transaction(async (tx) => {
    const where = and(
      eq(automationTemplateSuggestions.organizationId, input.organizationId),
      eq(automationTemplateSuggestions.generatedOn, input.generatedOn),
    );
    const [row] = await tx
      .select(suggestionRowColumns)
      .from(automationTemplateSuggestions)
      .where(where)
      .limit(1)
      .for("update");
    if (!row) return;
    const missing = Math.max(0, suggestedAutomationTemplateCount - shownTemplates(row).length);
    await tx
      .update(automationTemplateSuggestions)
      .set({
        refillRequestedAt: row.refillRequestedAt?.getTime() === input.requestedAt.getTime() ? null : row.refillRequestedAt,
        templates: [...row.templates, ...input.templates.slice(0, missing)],
        updatedAt: new Date(),
      })
      .where(where);
  });
}

// What the model reads about the organization: names only, no credentials or
// message content.
export async function getAutomationSuggestionContext(input: {
  day: string;
  now: Date;
  organizationId: string;
}): Promise<AutomationSuggestionContext | null> {
  const db = getDatabase();
  const [workspace] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, input.organizationId))
    .limit(1);
  if (!workspace) return null;
  const twoWeeksAgo = new Date(input.now.getTime() - 14 * 24 * 60 * 60 * 1_000);
  const [providers, repositoryRows, automationRows, issueRows, previousRows] = await Promise.all([
    db
      .selectDistinct({ provider: integrationAccounts.provider })
      .from(integrationAccounts)
      .where(and(eq(integrationAccounts.organizationId, input.organizationId), eq(integrationAccounts.status, "connected"))),
    db
      .select({ fullName: repositories.fullName })
      .from(repositories)
      .innerJoin(integrationAccounts, eq(repositories.integrationAccountId, integrationAccounts.id))
      .where(and(eq(integrationAccounts.organizationId, input.organizationId), eq(repositories.available, true)))
      .orderBy(desc(repositories.updatedAt))
      .limit(30),
    db
      .select({ description: automations.description, name: automations.name })
      .from(automations)
      .where(eq(automations.organizationId, input.organizationId))
      .orderBy(desc(automations.updatedAt))
      .limit(50),
    db
      .select({ severity: issues.severity, title: issues.title })
      .from(issues)
      .where(and(eq(issues.organizationId, input.organizationId), isNull(issues.archivedAt), gte(issues.createdAt, twoWeeksAgo)))
      .orderBy(desc(issues.createdAt))
      .limit(25),
    db
      .select({ removedTemplateIds: automationTemplateSuggestions.removedTemplateIds, templates: automationTemplateSuggestions.templates })
      .from(automationTemplateSuggestions)
      .where(and(
        eq(automationTemplateSuggestions.organizationId, input.organizationId),
        lte(automationTemplateSuggestions.generatedOn, input.day),
        eq(automationTemplateSuggestions.status, "ready"),
      ))
      .orderBy(desc(automationTemplateSuggestions.generatedOn))
      .limit(4),
  ]);
  // A removed suggestion that is not an automation was dismissed.
  const automationNames = new Set(automationRows.map((row) => row.name.trim().toLowerCase()));
  const dismissed = previousRows.flatMap((row) => row.templates.filter((template) =>
    row.removedTemplateIds.includes(template.id) && !automationNames.has(template.name.trim().toLowerCase())));
  return {
    automations: automationRows.map((row) => ({ description: row.description.slice(0, 300), name: row.name })),
    connectedProviders: providers.map((row) => row.provider).sort(),
    dismissedSuggestions: dismissed.map((template) => template.name),
    previousSuggestions: previousRows.flatMap((row) => row.templates.map((template) => template.name)),
    recentIssues: issueRows.map((row) => ({ severity: row.severity, title: row.title.slice(0, 200) })),
    repositories: repositoryRows.map((row) => row.fullName),
    workspaceName: workspace.name,
  };
}
