export function currentSupabaseProjectSelectionState(): string | null {
  if (typeof window === "undefined") return null;
  const search = new URLSearchParams(window.location.search);
  return search.get("integration") === "supabase" &&
      search.get("status") === "select_project"
    ? search.get("selection_state")
    : null;
}
