export function currentProjectSelectionState(
  provider: "gcp" | "supabase",
): string | null {
  if (typeof window === "undefined") return null;
  const search = new URLSearchParams(window.location.search);
  return search.get("integration") === provider &&
      search.get("status") === "select_project"
    ? search.get("selection_state")
    : null;
}
