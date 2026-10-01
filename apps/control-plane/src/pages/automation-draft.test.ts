import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationConfiguration, AutomationOptions } from "../automations-api";
import { connectedAccountIds, isCurrentAutomationDraft, restoreAutomationDraft, saveAutomationDraft, storedAutomationDraft, withConnectedAccounts, type AutomationDraft } from "./automation-draft";

const configuration = { contextAccountIds: ["existing"], workspaceSecretIds: ["secret"] } as unknown as AutomationConfiguration;
const draft = (connecting: string): AutomationDraft => ({ name: "Draft", configuration, githubIncluded: false, connecting, knownAccountIds: ["old"], savedAt: 0 });
const options = (accounts: Array<{ id: string; provider: string }>) => ({ accounts }) as unknown as AutomationOptions;

describe("automation draft", () => {
  it("does not store workspace secret selections", () => {
    expect(storedAutomationDraft(draft("sentry")).configuration).not.toHaveProperty("workspaceSecretIds");
  });

  it("finds accounts the connection flow created", () => {
    const loaded = options([{ id: "old", provider: "sentry" }, { id: "new", provider: "sentry" }, { id: "other", provider: "slack" }]);
    expect(connectedAccountIds(draft("sentry"), loaded, null)).toEqual(["new"]);
    expect(connectedAccountIds(draft("sentry"), loaded, "old")).toEqual(["old", "new"]);
    expect(connectedAccountIds(draft("sentry"), options([{ id: "old", provider: "sentry" }]), null)).toEqual([]);
  });

  it("adds new connections to the draft", () => {
    expect(withConnectedAccounts(draft("sentry"), ["new"]).configuration.contextAccountIds).toEqual(["existing", "new"]);
    expect(withConnectedAccounts(draft("github"), ["new"])).toMatchObject({ githubIncluded: true, configuration: { contextAccountIds: ["existing"] } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("restores the draft without an error while a Google Cloud project is picked", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    const triggers = { ...configuration, triggers: [] } as unknown as AutomationConfiguration;
    saveAutomationDraft({ ...draft("gcp"), configuration: triggers, savedAt: Date.now() });

    const restored = restoreAutomationDraft(
      options([]),
      { search: "?integration=gcp&status=select_project&selection_state=state" } as Location,
    );

    expect(restored).toMatchObject({ error: null, finishing: false });
    expect(restored?.draft.name).toBe("Draft");
  });

  it("ignores drafts older than a connection flow", () => {
    expect(isCurrentAutomationDraft(draft("sentry"), 10 * 60_000)).toBe(true);
    expect(isCurrentAutomationDraft(draft("sentry"), 10 * 60_000 + 1)).toBe(false);
  });
});
