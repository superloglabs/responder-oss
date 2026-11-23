// What to tell the person when a connection returns with a failure reason
// that needs them to do something other than try again.
export function connectionErrorDetail(reason: string | null): string | null {
  if (reason === "partial_repository_access") {
    return "Your GitHub account cannot see every repository the GitHub App is installed on. A GitHub organization owner or admin, or someone with access to all of those repositories, must connect it.";
  }
  return null;
}
