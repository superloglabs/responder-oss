export function responderIssueUrl(issueId: string, origin: string): string {
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Responder URLs must use HTTP or HTTPS");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/issues/${encodeURIComponent(issueId)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}
