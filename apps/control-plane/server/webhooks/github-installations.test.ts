import { afterEach, describe, expect, it, vi } from "vitest";
import { disableAgentsWithUnavailableRepositories } from "../../../../packages/core/src/db/agents.js";
import {
  listGitHubAccountsForInstallation,
  removeGitHubInstallationAccount,
  replaceRepositories,
  setIntegrationAccountStatus,
} from "../../../../packages/core/src/db/integrations.js";
import { listGitHubRepositories } from "../integrations/github.js";
import { syncGitHubInstallation } from "./github-installations.js";

vi.mock("../../../../packages/core/src/db/agents.js", () => ({
  disableAgentsWithUnavailableRepositories: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/integrations.js", () => ({
  listGitHubAccountsForInstallation: vi.fn(),
  removeGitHubInstallationAccount: vi.fn(),
  replaceRepositories: vi.fn(),
  setIntegrationAccountStatus: vi.fn(),
}));

vi.mock("../integrations/github.js", () => ({
  listGitHubRepositories: vi.fn(),
}));

const account = {
  id: "30000000-0000-4000-8000-000000000000",
  organizationId: "10000000-0000-4000-8000-000000000000",
};
const repository = {
  defaultBranch: "main",
  externalId: "987",
  fullName: "example/service",
  metadata: {},
  private: true,
};

describe("GitHub App installation changes", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("removes every connection to an uninstalled app", async () => {
    vi.mocked(listGitHubAccountsForInstallation).mockResolvedValue([account]);

    await expect(
      syncGitHubInstallation("installation", { action: "deleted", installation: { id: 789 } }),
    ).resolves.toBe("removed");
    expect(listGitHubAccountsForInstallation).toHaveBeenCalledWith(789);
    expect(removeGitHubInstallationAccount).toHaveBeenCalledWith(account.id);
  });

  it("marks a suspended installation as failed", async () => {
    vi.mocked(listGitHubAccountsForInstallation).mockResolvedValue([account]);

    await expect(
      syncGitHubInstallation("installation", { action: "suspend", installation: { id: 789 } }),
    ).resolves.toBe("suspended");
    expect(setIntegrationAccountStatus).toHaveBeenCalledWith(account.id, "error");
    expect(removeGitHubInstallationAccount).not.toHaveBeenCalled();
  });

  it("syncs repositories after the app's repository access changes", async () => {
    vi.mocked(listGitHubAccountsForInstallation).mockResolvedValue([account]);
    vi.mocked(listGitHubRepositories).mockResolvedValue([repository]);
    vi.mocked(disableAgentsWithUnavailableRepositories).mockResolvedValue([]);

    await expect(
      syncGitHubInstallation("installation_repositories", {
        action: "removed",
        installation: { id: 789 },
      }),
    ).resolves.toBe("synced");
    expect(listGitHubRepositories).toHaveBeenCalledWith(789);
    expect(replaceRepositories).toHaveBeenCalledWith(account.id, [repository]);
    expect(setIntegrationAccountStatus).toHaveBeenCalledWith(account.id, "connected");
    expect(disableAgentsWithUnavailableRepositories).toHaveBeenCalledWith(
      account.organizationId,
    );
  });

  it("ignores installations that no organization connected", async () => {
    vi.mocked(listGitHubAccountsForInstallation).mockResolvedValue([]);

    await expect(
      syncGitHubInstallation("installation", { action: "deleted", installation: { id: 789 } }),
    ).resolves.toBe("not_ours");
    expect(removeGitHubInstallationAccount).not.toHaveBeenCalled();
  });

  it("leaves new installations to the connection flow", async () => {
    await expect(
      syncGitHubInstallation("installation", { action: "created", installation: { id: 789 } }),
    ).resolves.toBe("ignored");
    expect(listGitHubAccountsForInstallation).not.toHaveBeenCalled();
  });
});
