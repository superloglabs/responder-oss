import { getOrganizationName } from "../db/organizations.js";

/** Enrich only error events, and keep reporting if the database is unavailable. */
export async function organizationErrorTags(
  organizationId: string | undefined,
): Promise<Record<string, string>> {
  if (!organizationId) return {};
  const tags: Record<string, string> = { organization_id: organizationId };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const name = await Promise.race([
      getOrganizationName(organizationId),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 250);
      }),
    ]);
    if (name) tags.organization_name = name;
  } catch {
    // A failed name lookup must not hide the original error.
  } finally {
    clearTimeout(timer);
  }
  return tags;
}
