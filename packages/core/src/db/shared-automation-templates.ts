import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  shareableAutomationConnectors,
  shareableAutomationTriggers,
} from "../automations/shared-template.js";
import { organization } from "./auth-schema.js";
import { getDatabase } from "./client.js";
import {
  automationVersionIntegrationAccounts,
  automationVersionRepositories,
  automationVersions,
  automations,
  integrationAccounts,
  sharedAutomationTemplates,
} from "./schema.js";

const shareColumns = {
  connectors: sharedAutomationTemplates.connectors,
  description: sharedAutomationTemplates.description,
  name: sharedAutomationTemplates.name,
  prompt: sharedAutomationTemplates.prompt,
  slug: sharedAutomationTemplates.slug,
  triggers: sharedAutomationTemplates.triggers,
  updatedAt: sharedAutomationTemplates.updatedAt,
};

function newSlug(): string {
  return randomBytes(12).toString("base64url");
}

export async function getAutomationShare(
  organizationId: string,
  automationId: string,
) {
  const rows = await getDatabase()
    .select(shareColumns)
    .from(sharedAutomationTemplates)
    .where(
      and(
        eq(sharedAutomationTemplates.automationId, automationId),
        eq(sharedAutomationTemplates.organizationId, organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// Shares the automation as it is now, or replaces the existing snapshot and
// keeps its link. Returns null when the automation is not in the
// organization.
export async function shareAutomation(input: {
  automationId: string;
  organizationId: string;
  userId: string;
}) {
  const db = getDatabase();
  const [version] = await db
    .select({
      description: automations.description,
      id: automationVersions.id,
      name: automations.name,
      prompt: automationVersions.prompt,
      triggers: automationVersions.triggers,
    })
    .from(automations)
    .innerJoin(
      automationVersions,
      eq(automationVersions.id, automations.activeVersionId),
    )
    .where(
      and(
        eq(automations.id, input.automationId),
        eq(automations.organizationId, input.organizationId),
      ),
    )
    .limit(1);
  if (!version) return null;
  const [accountRows, repositoryRows] = await Promise.all([
    db
      .select({ provider: integrationAccounts.provider })
      .from(automationVersionIntegrationAccounts)
      .innerJoin(
        integrationAccounts,
        eq(
          integrationAccounts.id,
          automationVersionIntegrationAccounts.integrationAccountId,
        ),
      )
      .where(
        and(
          eq(automationVersionIntegrationAccounts.automationVersionId, version.id),
          eq(automationVersionIntegrationAccounts.role, "context"),
        ),
      ),
    db
      .select({ id: automationVersionRepositories.repositoryId })
      .from(automationVersionRepositories)
      .where(eq(automationVersionRepositories.automationVersionId, version.id))
      .limit(1),
  ]);
  const triggers = shareableAutomationTriggers(version.triggers);
  const snapshot = {
    connectors: shareableAutomationConnectors({
      contextProviders: accountRows.map((row) => row.provider),
      hasRepositories: repositoryRows.length > 0,
      triggers,
    }),
    description: version.description,
    name: version.name,
    prompt: version.prompt,
    triggers,
    updatedAt: new Date(),
  };
  const slug = newSlug();
  const [share] = await db
    .insert(sharedAutomationTemplates)
    .values({
      ...snapshot,
      automationId: input.automationId,
      createdBy: input.userId,
      organizationId: input.organizationId,
      slug,
    })
    .onConflictDoUpdate({
      set: snapshot,
      target: sharedAutomationTemplates.automationId,
    })
    .returning(shareColumns);
  return { created: share!.slug === slug, share: share! };
}

// Deletes the snapshot, so its link stops working. Sharing again creates a
// new link.
export async function unshareAutomation(
  organizationId: string,
  automationId: string,
): Promise<boolean> {
  const rows = await getDatabase()
    .delete(sharedAutomationTemplates)
    .where(
      and(
        eq(sharedAutomationTemplates.automationId, automationId),
        eq(sharedAutomationTemplates.organizationId, organizationId),
      ),
    )
    .returning({ id: sharedAutomationTemplates.id });
  return rows.length > 0;
}

// The public view of a shared template. It names the owner's workspace and
// nothing else about it.
export async function getSharedAutomationTemplate(slug: string) {
  const rows = await getDatabase()
    .select({ ...shareColumns, workspaceName: organization.name })
    .from(sharedAutomationTemplates)
    .innerJoin(
      organization,
      eq(organization.id, sharedAutomationTemplates.organizationId),
    )
    .where(eq(sharedAutomationTemplates.slug, slug))
    .limit(1);
  return rows[0] ?? null;
}
