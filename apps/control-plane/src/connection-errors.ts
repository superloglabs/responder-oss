// What to tell the person when a connection returns with a failure reason
// that needs them to do something other than try again.
export function connectionErrorDetail(reason: string | null): string | null {
  if (reason === "partial_repository_access") {
    return "Your GitHub account cannot see every repository of this GitHub App installation. A GitHub organization owner or admin, or someone with access to every repository of that installation, must connect it.";
  }
  return null;
}
