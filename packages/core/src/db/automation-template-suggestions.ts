import { and, desc, eq, gt, gte, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import type { AutomationSuggestionContext, SuggestedAutomationTemplate } from "../automations/suggested-templates.js";
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

// Organizations with automations that a member used in the last week, which
// have no suggestions for the day yet. Operator impersonation does not count
// as use.
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

// The newest ready suggestions. A failed or generating day shows the previous
// day's set.
export async function getLatestAutomationSuggestions(
  organizationId: string,
): Promise<{ generatedOn: string; templates: SuggestedAutomationTemplate[] } | null> {
  const rows = await getDatabase()
    .select({ generatedOn: automationTemplateSuggestions.generatedOn, templates: automationTemplateSuggestions.templates })
    .from(automationTemplateSuggestions)
    .where(and(
      eq(automationTemplateSuggestions.organizationId, organizationId),
      eq(automationTemplateSuggestions.status, "ready"),
    ))
    .orderBy(desc(automationTemplateSuggestions.generatedOn))
    .limit(1);
  return rows[0] ?? null;
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
      .select({ templates: automationTemplateSuggestions.templates })
      .from(automationTemplateSuggestions)
      .where(and(
        eq(automationTemplateSuggestions.organizationId, input.organizationId),
        ne(automationTemplateSuggestions.generatedOn, input.day),
        eq(automationTemplateSuggestions.status, "ready"),
      ))
      .orderBy(desc(automationTemplateSuggestions.generatedOn))
      .limit(3),
  ]);
  return {
    automations: automationRows.map((row) => ({ description: row.description.slice(0, 300), name: row.name })),
    connectedProviders: providers.map((row) => row.provider).sort(),
    previousSuggestions: previousRows.flatMap((row) => row.templates.map((template) => template.name)),
    recentIssues: issueRows.map((row) => ({ severity: row.severity, title: row.title.slice(0, 200) })),
    repositories: repositoryRows.map((row) => row.fullName),
    workspaceName: workspace.name,
  };
}
