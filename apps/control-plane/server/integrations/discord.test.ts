import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discordAuthorizeUrl,
  exchangeDiscordCode,
  listDiscordChannels,
  registerDiscordAutomationCommand,
} from "./discord.js";

function configureDiscord() {
  vi.stubEnv("BETTER_AUTH_URL", "https://responder.example.com");
  vi.stubEnv("DISCORD_APPLICATION_ID", "application-1");
  vi.stubEnv("DISCORD_BOT_TOKEN", "bot-token");
  vi.stubEnv("DISCORD_CLIENT_SECRET", "client-secret");
}

describe("Discord integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("builds a guild installation URL", () => {
    configureDiscord();
    const url = new URL(discordAuthorizeUrl("connection-state"));

    expect(url.origin + url.pathname).toBe(
      "https://discord.com/oauth2/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("application-1");
    expect(url.searchParams.get("scope")).toBe(
      "identify applications.commands bot",
    );
    expect(url.searchParams.get("state")).toBe("connection-state");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://responder.example.com/api/integrations/discord/callback",
    );
  });

  it("exchanges the grant, discovers text channels, and registers the command", async () => {
    configureDiscord();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "oauth-access-token",
          expires_in: 604_800,
          guild: { id: "guild-1", name: "Example Guild" },
          refresh_token: "oauth-refresh-token",
          scope: "applications.commands bot",
          token_type: "Bearer",
        }),
      )
      .mockResolvedValueOnce(
        Response.json([
          { id: "category-1", name: "Engineering", position: 0, type: 4 },
          { id: "channel-2", name: "incidents", position: 2, type: 0 },
          { id: "channel-1", name: "alerts", position: 1, type: 5 },
        ]),
      )
      .mockResolvedValueOnce(Response.json({ id: "command-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeDiscordCode("oauth-code")).resolves.toMatchObject({
      guild: { id: "guild-1", name: "Example Guild" },
    });
    await expect(listDiscordChannels("guild-1")).resolves.toEqual([
      {
        displayName: "alerts",
        externalId: "channel-1",
        metadata: { type: 5 },
      },
      {
        displayName: "incidents",
        externalId: "channel-2",
        metadata: { type: 0 },
      },
    ]);
    await expect(
      registerDiscordAutomationCommand("guild-1"),
    ).resolves.toBeUndefined();

    const tokenRequest = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(String(tokenRequest.body)).toContain("code=oauth-code");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://discord.com/api/v10/guilds/guild-1/channels",
    );
    expect(
      new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers).get(
        "authorization",
      ),
    ).toBe("Bot bot-token");
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://discord.com/api/v10/applications/application-1/guilds/guild-1/commands",
    );
  });
});
