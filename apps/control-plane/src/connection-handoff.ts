// Sentry's install verification ends its flow on /settings instead of the
// requested return path. Send that result back to the automation flow that
// started it: a connection popup, or a draft saved before a same-tab connection.
export function connectionHandoffUrl({ search, windowName, pendingDraft }: {
  search: string;
  windowName: string;
  pendingDraft: { automationId?: string; connecting: string } | null;
}): string | null {
  const params = new URLSearchParams(search);
  const integration = params.get("integration");
  const status = params.get("status");
  if (!integration || !status) return null;
  const result = new URLSearchParams({ integration, status });
  const reason = params.get("reason");
  if (reason) result.set("reason", reason);
  const popup = /^automation-connect-([\w-]+)$/.exec(windowName);
  if (popup) return `/automations/connection-complete?${new URLSearchParams({ request: popup[1] })}&${result}`;
  if (status === "finishing" && pendingDraft?.connecting === integration) {
    return `/automations/${pendingDraft.automationId ? encodeURIComponent(pendingDraft.automationId) : "new"}?${result}`;
  }
  return null;
}
