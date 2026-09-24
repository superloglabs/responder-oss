import type { AutomationConfiguration, AutomationOptions } from "../automations-api";
import { providerDisplayName } from "../components/provider-glyphs";

// Keeps a new automation's draft while a connector is connected in the same
// tab. The connection flow returns to the create page with its result.
const storageKey = "responder.automationDraft";

export interface AutomationDraft {
  name: string;
  configuration: AutomationConfiguration;
  triggerSelected: boolean;
  githubIncluded: boolean;
  connecting: string;
  // Accounts of the connecting provider before the flow, to find the new one.
  knownAccountIds: string[];
}

export function saveAutomationDraft(draft: AutomationDraft) {
  try { window.sessionStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* The draft is lost only if storage is unavailable. */ }
}

export function takeAutomationDraft(): AutomationDraft | null {
  try {
    const value = window.sessionStorage.getItem(storageKey);
    window.sessionStorage.removeItem(storageKey);
    return value ? JSON.parse(value) as AutomationDraft : null;
  } catch {
    return null;
  }
}

// Returns the saved draft when the page is loaded by the connection flow,
// with the connection it created added to the draft.
export function restoreAutomationDraft(options: AutomationOptions, location: Location): { draft: AutomationDraft; error: string | null } | null {
  const draft = takeAutomationDraft();
  const search = new URLSearchParams(location.search);
  const provider = search.get("integration");
  if (!draft || provider !== draft.connecting) return null;
  const status = search.get("status");
  const connected = status === "connected" || status === "finishing";
  const returnedAccountId = search.get("integration_account_id");
  const added = connected
    ? options.accounts.filter((account) => account.provider === provider && (account.id === returnedAccountId || !draft.knownAccountIds.includes(account.id))).map((account) => account.id)
    : [];
  const restored = provider === "github"
    ? { ...draft, githubIncluded: draft.githubIncluded || added.length > 0 }
    : { ...draft, configuration: { ...draft.configuration, contextAccountIds: [...new Set([...draft.configuration.contextAccountIds, ...added])] } };
  const name = providerDisplayName(provider);
  return {
    draft: restored,
    error: connected ? null : search.get("reason") === "cancelled" ? `${name} connection was cancelled.` : `${name} could not be connected.`,
  };
}
