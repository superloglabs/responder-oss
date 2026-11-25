// What to tell the person when a connection returns with a failure reason
// that needs them to do something other than try again.
export function connectionErrorDetail(reason: string | null): string | null {
  if (reason === "partial_repository_access") {
    return "Your GitHub account cannot see every repository of this GitHub App installation. A GitHub organization owner or admin, or someone with access to every repository of that installation, must connect it.";
  }
  if (reason === "read_only_repository_access") {
    return "Your GitHub account can only read some repositories of this GitHub App installation. Superlog can change code in every repository the installation covers, so a GitHub organization owner or admin, or someone with write access to every repository of that installation, must connect it.";
  }
  if (reason === "slack_team_connected_elsewhere") {
    return "This Slack workspace is already connected to another Superlog workspace. An owner or admin of that Superlog workspace must connect it here.";
  }
  return null;
}
