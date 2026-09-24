import { describe, expect, it } from "vitest";
import type { AutomationConfiguration, AutomationOptions } from "../automations-api";
import { connectedAccountIds, isCurrentAutomationDraft, storedAutomationDraft, withConnectedAccounts, type AutomationDraft } from "./automation-draft";

const configuration = { contextAccountIds: ["existing"], workspaceSecretIds: ["secret"] } as unknown as AutomationConfiguration;
const draft = (connecting: string): AutomationDraft => ({ name: "Draft", configuration, triggerSelected: false, githubIncluded: false, connecting, knownAccountIds: ["old"], savedAt: 0 });
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

  it("ignores drafts older than a connection flow", () => {
    expect(isCurrentAutomationDraft(draft("sentry"), 10 * 60_000)).toBe(true);
    expect(isCurrentAutomationDraft(draft("sentry"), 10 * 60_000 + 1)).toBe(false);
  });
});
