import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptCredentials, encryptCredentials } from "../credentials/encryption.js";
import { JiraOAuthGrantError, refreshJiraOAuthCredentials } from "../integrations/jira.js";
import { getOrganizationIntegrationAccount, withIntegrationAccountCredentialLease } from "./integrations.js";
import { jiraAccountAuth } from "./jira-accounts.js";

vi.mock("../credentials/encryption.js", () => ({
  decryptCredentials: vi.fn((value: string) => JSON.parse(value) as unknown),
  encryptCredentials: vi.fn((value: unknown) => JSON.stringify(value)),
}));
vi.mock("./integrations.js", () => ({
  getOrganizationIntegrationAccount: vi.fn(),
  withIntegrationAccountCredentialLease: vi.fn(),
}));
vi.mock("../integrations/jira.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../integrations/jira.js")>(),
  refreshJiraOAuthCredentials: vi.fn(),
}));

const ids = { organizationId: "org-1", integrationAccountId: "account-1" };
const oauth = {
  authType: "jira_oauth" as const,
  siteUrl: "https://example.atlassian.net",
  cloudId: "cloud-1",
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: Date.now() + 3_600_000,
  scope: "",
};

function stored(credentials: unknown, status = "connected") {
  vi.mocked(getOrganizationIntegrationAccount).mockResolvedValue({
    id: "account-1", encryptedCredentials: JSON.stringify(credentials), metadata: {}, status,
  } as Awaited<ReturnType<typeof getOrganizationIntegrationAccount>>);
}

describe("jiraAccountAuth", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses an API token and a fresh access token as stored", async () => {
    stored({ authType: "api_token", siteUrl: "https://example.atlassian.net", email: "dev@example.com", token: "t" });
    await expect(jiraAccountAuth(ids)).resolves.toEqual({ siteUrl: "https://example.atlassian.net", email: "dev@example.com", token: "t" });

    stored(oauth);
    await expect(jiraAccountAuth(ids)).resolves.toEqual({ siteUrl: oauth.siteUrl, cloudId: "cloud-1", accessToken: "old-access" });
    expect(withIntegrationAccountCredentialLease).not.toHaveBeenCalled();
  });

  it("returns nothing for a failed connection", async () => {
    stored(oauth, "error");
    await expect(jiraAccountAuth(ids)).resolves.toBeNull();
  });

  it("refreshes an expiring token under the lease and stores the rotated one", async () => {
    const expiring = { ...oauth, expiresAt: Date.now() + 10_000 };
    const refreshed = { ...oauth, accessToken: "new-access", refreshToken: "new-refresh" };
    stored(expiring);
    vi.mocked(refreshJiraOAuthCredentials).mockResolvedValue(refreshed);
    let saved: string | undefined;
    vi.mocked(withIntegrationAccountCredentialLease).mockImplementation(async (input) => {
      const result = await input.operation(JSON.stringify(expiring), {});
      saved = result.encryptedCredentials;
      return result.value as never;
    });

    await expect(jiraAccountAuth(ids)).resolves.toEqual({ siteUrl: oauth.siteUrl, cloudId: "cloud-1", accessToken: "new-access" });
    expect(refreshJiraOAuthCredentials).toHaveBeenCalledWith(expiring);
    expect(saved && decryptCredentials(saved)).toEqual(refreshed);
    expect(encryptCredentials).toHaveBeenCalledWith(refreshed);
  });

  it("does not refresh again when another caller already did", async () => {
    stored({ ...oauth, expiresAt: Date.now() + 10_000 });
    vi.mocked(withIntegrationAccountCredentialLease).mockImplementation(async (input) =>
      (await input.operation(JSON.stringify(oauth), {})).value as never);

    await expect(jiraAccountAuth(ids)).resolves.toMatchObject({ accessToken: "old-access" });
    expect(refreshJiraOAuthCredentials).not.toHaveBeenCalled();
  });

  it("uses a token another caller refreshed when the lease could not be taken", async () => {
    vi.mocked(getOrganizationIntegrationAccount)
      .mockResolvedValueOnce({ id: "account-1", encryptedCredentials: JSON.stringify({ ...oauth, expiresAt: Date.now() + 10_000 }), metadata: {}, status: "connected" } as never)
      .mockResolvedValueOnce({ id: "account-1", encryptedCredentials: JSON.stringify({ ...oauth, accessToken: "new-access" }), metadata: {}, status: "connected" } as never);
    vi.mocked(withIntegrationAccountCredentialLease).mockResolvedValue(null);

    await expect(jiraAccountAuth(ids)).resolves.toMatchObject({ accessToken: "new-access" });
  });

  it("reports a refresh that did not finish instead of a missing connection", async () => {
    stored({ ...oauth, expiresAt: Date.now() + 10_000 });
    vi.mocked(withIntegrationAccountCredentialLease).mockResolvedValue(null);

    await expect(jiraAccountAuth(ids)).rejects.toThrow("The Jira token could not be refreshed");
  });

  it("returns nothing when the connection was removed during the refresh", async () => {
    vi.mocked(getOrganizationIntegrationAccount)
      .mockResolvedValueOnce({ id: "account-1", encryptedCredentials: JSON.stringify({ ...oauth, expiresAt: Date.now() + 10_000 }), metadata: {}, status: "connected" } as never)
      .mockResolvedValueOnce(null as never);
    vi.mocked(withIntegrationAccountCredentialLease).mockResolvedValue(null);

    await expect(jiraAccountAuth(ids)).resolves.toBeNull();
  });

  it("marks the connection failed only when Atlassian refuses the grant", async () => {
    stored({ ...oauth, expiresAt: Date.now() + 10_000 });
    vi.mocked(withIntegrationAccountCredentialLease).mockResolvedValue(null);
    await expect(jiraAccountAuth(ids)).rejects.toThrow("The Jira token could not be refreshed");
    const { statusOnError } = vi.mocked(withIntegrationAccountCredentialLease).mock.calls[0]![0];
    expect(statusOnError?.(new JiraOAuthGrantError(403, "invalid_grant"))).toBe("error");
    expect(statusOnError?.(new Error("timeout"))).toBeUndefined();
  });
});
