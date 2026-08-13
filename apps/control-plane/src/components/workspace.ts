export function workspaceSlug(
  name: string,
  uniqueSuffix: string = crypto.randomUUID(),
): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  return base ? `${base}-${uniqueSuffix}` : "";
}
