import { afterEach, describe, expect, it, vi } from "vitest";
import { disableAgentsWithUnavailableRepositories } from "../../../../packages/core/src/db/agents.js";
import {
  disconnectGitHubInstallationAccount,
  listGitHubAccountsForInstallation,
  removeGitHubInstallationAccount,
  replaceRepositories,
  setIntegrationAccountStatus,
} from "../../../../packages/core/src/db/integrations.js";
import { GitHubInstallationNotFoundError } from "../../../../packages/core/src/integrations/github.js";
import { listGitHubRepositories } from "../integrations/github.js";
import { syncGitHubInstallation } from "./github-installations.js";

vi.mock("../../../../packages/core/src/db/agents.js", () => ({
  disableAgentsWithUnavailableRepositories: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/integrations.js", () => ({
  disconnectGitHubInstallationAccount: vi.fn(),
  listGitHubAccountsForInstallation: vi.fn(),
  removeGitHubInstallationAccount: vi.fn(),
  replaceRepositories: vi.fn(),
  setIntegrationAccountStatus: vi.fn(),
}));

vi.mock("../integrations/github.js", () => ({
  listGitHubRepositories: vi.fn(),
}));

const firstAccount = {
  id: "30000000-0000-4000-8000-000000000000",
  organizationId: "10000000-0000-4000-8000-000000000000",
};
const secondAccount = {
  id: "30000000-0000-4000-8000-000000000001",
  organizationId: "10000000-0000-4000-8000-000000000001",
};
const repository = {
  defaultBranch: "main",
  externalId: "987",
  fullName: "example/service",
  metadata: {},
  private: true,
};
const installation = { id: 789 };

describe("GitHub App installation changes", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("removes every connection to an uninstalled app and pauses affected agents", async () => {
    vi.mocked(listGitHubAccountsForInstallation).mockResolvedValue([firstAccount, secondAccount]);

    await expect(
      syncGitHubInstallation("installation", { action: "deleted", installation }),
    ).resolves.toBe("removed");
    expect(listGitHubAccountsForInstallation).toHaveBeenCalledWith(789);
    expect(removeGitHubInstallationAccount).toHaveBeenCalledWith(firstAccount.id);
    expect(removeGitHubInstallationAccount).toHaveBeenCalledWith(secondAccount.id);
    expect(disableAgentsWithUnavailableRepositories).toHaveBeenCalledWith(firstAccount.organizationId);
    expect(disableAgentsWithUnavailableRepositories).toHaveBeenCalledWith(secondAccount.organizationId);
  });

  it("removes the other connections when one fails, then reports the failure", async () => {
    vi.mocked(listGitHubAccountsForInstallation).mockResolvedValue([firstAccount, secondAccount]);
    vi.mocked(removeGitHubInstallationAccount)
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce("removed");

    await expect(
      syncGitHubInstallation("installation", { action: "deleted", installation }),
    ).rejects.toThrow("database unavailable");
    expect(removeGitHubInstallationAccount).toHaveBeenCalledWith(secondAccount.id);
    expect(disableAgentsWithUnavailableRepositories).toHaveBeenCalledTimes(2);
  });

  it("disconnects a suspended installation and pauses affected agents", async () => {
    vi.mocked(listGitHubAccountsForInstallation).mockResolvedValue([firstAccount]);

    await expect(
      syncGitHubInstallation("installation", { action: "suspend", installation }),
    ).resolves.toBe("suspended");
    expect(disconnectGitHubInstallationAccount).toHaveBeenCalledWith(firstAccount.id);
    expect(disableAgentsWithUnavailableRepositories).toHaveBeenCalledWith(firstAccount.organizationId);
    expect(removeGitHubInstallationAccount).not.toHaveBeenCalled();
  });

  it.each([
    ["installation_repositories", "added"],
    ["installation_repositories", "removed"],
    ["installation", "unsuspend"],
    ["installation", "new_permissions_accepted"],
  ] as const)("syncs repositories and reconnects after %s %s", async (eventType, action) => {
    vi.mocked(listGitHubAccountsForInstallation).mockResolvedValue([firstAccount]);
    vi.mocked(listGitHubRepositories).mockResolvedValue([repository]);
    vi.mocked(disableAgentsWithUnavailableRepositories).mockResolvedValue([]);

    await expect(
      syncGitHubInstallation(eventType, { action, installation }),
    ).resolves.toBe("synced");
    expect(listGitHubRepositories).toHaveBeenCalledWith(789);
    expect(replaceRepositories).toHaveBeenCalledWith(firstAccount.id, [repository]);
    expect(setIntegrationAccountStatus).toHaveBeenCalledWith(firstAccount.id, "connected");
    expect(disableAgentsWithUnavailableRepositories).toHaveBeenCalledWith(
      firstAccount.organizationId,
    );
  });

  it("removes the connection when the installation is gone before a resync", async () => {
    vi.mocked(listGitHubAccountsForInstallation).mockResolvedValue([firstAccount]);
    vi.mocked(listGitHubRepositories).mockRejectedValue(new GitHubInstallationNotFoundError(789));

    await expect(
      syncGitHubInstallation("installation_repositories", { action: "added", installation }),
    ).resolves.toBe("removed");
    expect(removeGitHubInstallationAccount).toHaveBeenCalledWith(firstAccount.id);
    expect(replaceRepositories).not.toHaveBeenCalled();
  });

  it("ignores installations that no organization connected", async () => {
    vi.mocked(listGitHubAccountsForInstallation).mockResolvedValue([]);

    await expect(
      syncGitHubInstallation("installation", { action: "deleted", installation }),
    ).resolves.toBe("not_ours");
    expect(removeGitHubInstallationAccount).not.toHaveBeenCalled();
  });

  it("leaves new installations to the connection flow", async () => {
    await expect(
      syncGitHubInstallation("installation", { action: "created", installation }),
    ).resolves.toBe("ignored");
    expect(listGitHubAccountsForInstallation).not.toHaveBeenCalled();
  });
});
