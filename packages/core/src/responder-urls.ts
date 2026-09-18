function responderUrl(origin: string): URL {
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Responder URLs must use HTTP or HTTPS");
  }
  return url;
}

export function responderIssueUrl(issueId: string, origin: string): string {
  const url = responderUrl(origin);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/issues/${encodeURIComponent(issueId)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function responderInvestigationUrl(input: {
  agentId: string;
  investigationId: string;
  organizationId?: string;
  origin: string;
}): string {
  const url = responderUrl(input.origin);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/agents/${encodeURIComponent(input.agentId)}/investigations/${encodeURIComponent(input.investigationId)}`;
  url.search = "";
  url.hash = "";
  if (input.organizationId) {
    url.searchParams.set("organization_id", input.organizationId);
  }
  return url.toString();
}
