import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptCredentials } from "../credentials/encryption.js";
import { getRuntimeSlackConnection } from "./investigations.js";
import { getDatabase } from "./client.js";

vi.mock("./client.js", () => ({ getDatabase: vi.fn() }));
vi.mock("../credentials/encryption.js", () => ({
  decryptCredentials: vi.fn(),
  encryptCredentials: vi.fn(),
}));

const resourceOne = "10000000-0000-4000-8000-000000000001";
const resourceTwo = "10000000-0000-4000-8000-000000000002";

function databaseDouble(resources: unknown[]) {
  const configQuery = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    limit: vi.fn().mockResolvedValue([
      {
        contextResourceIds: [resourceOne, resourceTwo],
        organizationId: "20000000-0000-4000-8000-000000000000",
      },
    ]),
  };
  configQuery.from.mockReturnValue(configQuery);
  configQuery.innerJoin.mockReturnValue(configQuery);
  configQuery.where.mockReturnValue(configQuery);

  const resourceQuery = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn().mockResolvedValue(resources),
  };
  resourceQuery.from.mockReturnValue(resourceQuery);
  resourceQuery.innerJoin.mockReturnValue(resourceQuery);

  vi.mocked(getDatabase).mockReturnValue({
    select: vi
      .fn()
      .mockReturnValueOnce(configQuery)
      .mockReturnValueOnce(resourceQuery),
  } as never);
}

describe("runtime Slack context", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("loads only the complete selected channel set in configured order", async () => {
    databaseDouble([
      {
        id: resourceTwo,
        accountId: "slack-account-1",
        displayName: "engineering",
        encryptedCredentials: "encrypted",
        externalId: "C456",
      },
      {
        id: resourceOne,
        accountId: "slack-account-1",
        displayName: "incidents",
        encryptedCredentials: "encrypted",
        externalId: "C123",
      },
    ]);
    vi.mocked(decryptCredentials).mockReturnValue({
      userAccessToken: "user-token",
    });

    await expect(
      getRuntimeSlackConnection("30000000-0000-4000-8000-000000000000"),
    ).resolves.toEqual({
      accountId: "slack-account-1",
      channels: [
        { id: "C123", name: "incidents" },
        { id: "C456", name: "engineering" },
      ],
      mcpUrl: "https://mcp.slack.com/mcp",
      userAccessToken: "user-token",
    });
  });

  it("rejects a partial resource result instead of crossing tenant scope", async () => {
    databaseDouble([
      {
        id: resourceOne,
        accountId: "slack-account-1",
        displayName: "incidents",
        encryptedCredentials: "encrypted",
        externalId: "C123",
      },
    ]);

    await expect(
      getRuntimeSlackConnection("30000000-0000-4000-8000-000000000000"),
    ).resolves.toBeNull();
    expect(decryptCredentials).not.toHaveBeenCalled();
  });

  it("logs the configuration version when Slack credentials are invalid", async () => {
    const versionId = "30000000-0000-4000-8000-000000000000";
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});
    databaseDouble([
      {
        id: resourceOne,
        accountId: "slack-account-1",
        displayName: "incidents",
        encryptedCredentials: "encrypted",
        externalId: "C123",
      },
      {
        id: resourceTwo,
        accountId: "slack-account-1",
        displayName: "engineering",
        encryptedCredentials: "encrypted",
        externalId: "C456",
      },
    ]);
    vi.mocked(decryptCredentials).mockReturnValue({});

    await expect(getRuntimeSlackConnection(versionId)).resolves.toBeNull();
    expect(logError).toHaveBeenCalledWith(
      JSON.stringify({
        event: "slack_context_credentials_invalid",
        versionId,
      }),
    );
  });
});
