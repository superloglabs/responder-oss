import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackApiError } from "../../../../packages/core/src/integrations/slack.js";
import { listNamedSlackAuthors } from "./slack-authors.js";

const mocks = vi.hoisted(() => ({
  account: vi.fn(),
  list: vi.fn(),
  lookup: vi.fn(),
  save: vi.fn(),
}));

vi.mock("../../../../packages/core/src/db/automations.js", () => ({
  listSlackMessageAuthors: mocks.list,
  nameSlackMessageAuthors: mocks.save,
}));
vi.mock("../../../../packages/core/src/db/integrations.js", () => ({
  getOrganizationIntegrationAccount: mocks.account,
}));
vi.mock("../../../../packages/core/src/credentials/encryption.js", () => ({
  decryptCredentials: () => ({ accessToken: "xoxb-test" }),
}));
vi.mock("../../../../packages/core/src/integrations/slack.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../packages/core/src/integrations/slack.js")>(),
  getSlackAuthorName: mocks.lookup,
}));

const input = {
  channelIds: ["C1"],
  integrationAccountId: "41414141-4141-4141-8141-414141414141",
  organizationId: "organization",
};
const datadog = { id: "AR28NTK5M", kind: "app", name: "Datadog" } as const;
const person = { id: "U0990LUEJKW", kind: "person", name: "U0990LUEJKW" } as const;
const bot = { id: "B09UTRWSBQQ", kind: "app", name: "B09UTRWSBQQ" } as const;
const connected = {
  encryptedCredentials: "sealed",
  metadata: { scopes: ["chat:write", "users:read"] },
  status: "connected",
};

describe("Slack author names", () => {
  beforeEach(() => {
    mocks.list.mockResolvedValue([datadog, person, bot]);
    mocks.account.mockResolvedValue(connected);
    mocks.save.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("looks up and saves the names of authors listed by ID", async () => {
    mocks.lookup.mockImplementation(({ id }: { id: string }) => Promise.resolve(id === person.id ? "Ada" : "Release Bot"));

    await expect(listNamedSlackAuthors(input)).resolves.toEqual({
      authors: [datadog, { ...person, name: "Ada" }, { ...bot, name: "Release Bot" }],
      namesNeedReconnect: false,
    });
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
    expect(mocks.save).toHaveBeenCalledWith({
      integrationAccountId: input.integrationAccountId,
      names: [{ id: person.id, name: "Ada" }, { id: bot.id, name: "Release Bot" }],
    });
  });

  it("lists IDs and asks for a reconnect when the connection cannot look names up", async () => {
    mocks.account.mockResolvedValue({ ...connected, metadata: { scopes: ["chat:write"] } });

    await expect(listNamedSlackAuthors(input)).resolves.toEqual({
      authors: [datadog, person, bot],
      namesNeedReconnect: true,
    });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("asks for a reconnect when Slack says the scope is missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.lookup.mockRejectedValue(new SlackApiError("users.info", "missing_scope"));

    await expect(listNamedSlackAuthors(input)).resolves.toEqual({
      authors: [datadog, person, bot],
      namesNeedReconnect: true,
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("keeps the ID of an author whose lookup fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.lookup.mockImplementation(({ id }: { id: string }) =>
      id === person.id ? Promise.resolve("Ada") : Promise.reject(new SlackApiError("bots.info", "ratelimited"))
    );

    await expect(listNamedSlackAuthors(input)).resolves.toEqual({
      authors: [datadog, { ...person, name: "Ada" }, bot],
      namesNeedReconnect: false,
    });
  });

  it("does not load the connection when every author has a name", async () => {
    mocks.list.mockResolvedValue([datadog]);

    await expect(listNamedSlackAuthors(input)).resolves.toEqual({ authors: [datadog], namesNeedReconnect: false });
    expect(mocks.account).not.toHaveBeenCalled();
  });
});
