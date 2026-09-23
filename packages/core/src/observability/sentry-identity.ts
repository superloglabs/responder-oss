import { getOrganizationName } from "../db/organizations.js";

/** Enrich only error events, and keep reporting if the database is unavailable. */
export async function organizationErrorTags(
  organizationId: string | undefined,
): Promise<Record<string, string>> {
  if (!organizationId) return {};
  const tags: Record<string, string> = { organization_id: organizationId };
  try {
    const name = await getOrganizationName(organizationId);
    if (name) tags.organization_name = name;
  } catch {
    // A failed name lookup must not hide the original error.
  }
  return tags;
}
