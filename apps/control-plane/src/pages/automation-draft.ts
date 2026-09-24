import { fetchAutomationOptions, type AutomationConfiguration, type AutomationOptions } from "../automations-api";
import { providerDisplayName } from "../components/provider-glyphs";

// Keeps a new automation's draft while a connector is connected in the same
// tab. The connection flow returns to the create page with its result.
const storageKey = "responder.automationDraft";
// Matches the server's connection state lifetime; an older draft belongs to an
// abandoned flow.
const draftLifetimeMs = 10 * 60_000;

export interface AutomationDraft {
  name: string;
  configuration: AutomationConfiguration;
  triggerSelected: boolean;
  githubIncluded: boolean;
  connecting: string;
  // Accounts of the connecting provider before the flow, to find the new one.
  knownAccountIds: string[];
  savedAt: number;
}

export function isCurrentAutomationDraft(draft: AutomationDraft, now: number) {
  return now - draft.savedAt <= draftLifetimeMs;
}

// Workspace secret selections stay in memory only and are chosen again after
// connecting.
export function storedAutomationDraft(draft: AutomationDraft) {
  const configuration = Object.fromEntries(Object.entries(draft.configuration).filter(([key]) => key !== "workspaceSecretIds")) as Omit<AutomationConfiguration, "workspaceSecretIds">;
  return { ...draft, configuration };
}

export function saveAutomationDraft(draft: AutomationDraft) {
  try { window.sessionStorage.setItem(storageKey, JSON.stringify(storedAutomationDraft(draft))); } catch { /* The draft is lost only if storage is unavailable. */ }
}

function readAutomationDraft(): AutomationDraft | null {
  try {
    const value = window.sessionStorage.getItem(storageKey);
    if (!value) return null;
    const stored = JSON.parse(value) as ReturnType<typeof storedAutomationDraft>;
    const draft = { ...stored, configuration: { ...stored.configuration, workspaceSecretIds: [] } };
    return isCurrentAutomationDraft(draft, Date.now()) ? draft : null;
  } catch {
    return null;
  }
}

export function takeAutomationDraft(): AutomationDraft | null {
  const draft = readAutomationDraft();
  try { window.sessionStorage.removeItem(storageKey); } catch { /* Nothing to remove. */ }
  return draft;
}

export function pendingAutomationDraftProvider(): string | null {
  return readAutomationDraft()?.connecting ?? null;
}

export function connectedAccountIds(draft: AutomationDraft, options: AutomationOptions, returnedAccountId: string | null): string[] {
  return options.accounts
    .filter((account) => account.provider === draft.connecting && (account.id === returnedAccountId || !draft.knownAccountIds.includes(account.id)))
    .map((account) => account.id);
}

export function withConnectedAccounts(draft: AutomationDraft, accountIds: string[]): AutomationDraft {
  if (!accountIds.length) return draft;
  if (draft.connecting === "github") return { ...draft, githubIncluded: true };
  return { ...draft, configuration: { ...draft.configuration, contextAccountIds: [...new Set([...draft.configuration.contextAccountIds, ...accountIds])] } };
}

// Returns the saved draft when the page is loaded by the connection flow,
// with the connection it created added. `finishing` means the provider may
// still be creating the account, so the caller keeps checking for it.
export function restoreAutomationDraft(options: AutomationOptions, location: Location): { draft: AutomationDraft; error: string | null; finishing: boolean; returnedAccountId: string | null } | null {
  const draft = takeAutomationDraft();
  const search = new URLSearchParams(location.search);
  const provider = search.get("integration");
  if (!draft || provider !== draft.connecting) return null;
  const status = search.get("status");
  const connected = status === "connected" || status === "finishing";
  const returnedAccountId = search.get("integration_account_id");
  const added = connected ? connectedAccountIds(draft, options, returnedAccountId) : [];
  const name = providerDisplayName(provider);
  return {
    draft: withConnectedAccounts(draft, added),
    error: connected ? null : search.get("reason") === "cancelled" ? `${name} connection was cancelled.` : `${name} could not be connected.`,
    finishing: status === "finishing" && !added.length,
    returnedAccountId,
  };
}

// A provider that reports `finishing` may create the account shortly after
// returning. Checks for it for up to ten seconds.
export async function waitForConnectedAccounts(draft: AutomationDraft, returnedAccountId: string | null, isCancelled: () => boolean): Promise<{ options: AutomationOptions; accountIds: string[] } | null> {
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (isCancelled()) return null;
    const options = await fetchAutomationOptions().catch(() => null);
    if (isCancelled()) return null;
    const accountIds = options ? connectedAccountIds(draft, options, returnedAccountId) : [];
    if (options && accountIds.length) return { options, accountIds };
  }
  return null;
}
