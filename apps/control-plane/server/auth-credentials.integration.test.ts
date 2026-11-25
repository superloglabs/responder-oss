import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey, authenticateApiKey } from "../../../packages/core/src/db/api-keys.js";
import {
  member,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
  organization,
  verification,
} from "../../../packages/core/src/db/auth-schema.js";
import { closeDatabase, getDatabase } from "../../../packages/core/src/db/client.js";
import { hashOAuthAccessToken } from "../../../packages/core/src/db/oauth-access-tokens.js";

const sentEmails = vi.hoisted(() => [] as Array<{ html?: string; text?: string; to: string }>);

vi.mock("@responder/core/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@responder/core/email")>()),
  sendEmail: vi.fn(async (message: { html?: string; text?: string; to: string }) => {
    sentEmails.push(message);
    return true;
  }),
}));
vi.mock("@responder/core/analytics", () => ({ captureAnalyticsEvent: vi.fn() }));
vi.mock("@responder/core/loops-contacts", () => ({ syncLoopsSignupContact: vi.fn() }));
vi.mock("@responder/core/reddit-conversions", () => ({ captureRedditSignupConversion: vi.fn() }));
vi.mock("@responder/core/x-conversions", () => ({ captureXSignupConversion: vi.fn() }));

const baseURL = "http://localhost:3000";
const superuserEmail = `support-${randomUUID()}@example.com`;

// Plain SQL, since this app reaches the schema only through @responder/core.
async function query<Row extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<Row[]> {
  const { $client } = getDatabase() as unknown as {
    $client: { query(text: string, values: unknown[]): Promise<{ rows: unknown[] }> };
  };
  const result = await $client.query(text, values);
  return result.rows as Row[];
}

// Run against a disposable, migrated PostgreSQL database only.
const testUrl = process.env.TEST_AUTH_CREDENTIALS_DATABASE_URL;
describe.skipIf(!testUrl)("account credentials (PostgreSQL)", () => {
  let auth: ReturnType<typeof import("./auth.js").createResponderAuth>;
  const createdUsers: string[] = [];
  const createdOrganizations: string[] = [];

  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!);
    vi.stubEnv("DATABASE_POOL_SIZE", "2");
    vi.stubEnv("BETTER_AUTH_URL", baseURL);
    vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-test-secret-test-secret");
    vi.stubEnv("SUPERUSER_EMAILS", superuserEmail);
    const { createResponderAuth } = await import("./auth.js");
    auth = createResponderAuth();
  });

  beforeEach(() => {
    sentEmails.length = 0;
  });

  afterAll(async () => {
    await query("delete from organization where id = any($1::uuid[])", [createdOrganizations]);
    await query(`delete from "user" where id = any($1::uuid[])`, [createdUsers]);
    await closeDatabase();
    vi.unstubAllEnvs();
  });

  async function request(
    path: string,
    init: { body?: unknown; cookie?: string; method?: string } = {},
  ): Promise<Response> {
    const headers = new Headers({ origin: baseURL });
    if (init.body !== undefined) headers.set("content-type", "application/json");
    if (init.cookie) headers.set("cookie", init.cookie);
    return auth.handler(
      new Request(new URL(path, baseURL), {
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        headers,
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        redirect: "manual",
      }),
    );
  }

  function sessionCookie(response: Response): string {
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("responder-auth.session_token="));
    if (!cookie) throw new Error(`no session cookie (status ${response.status})`);
    return cookie.split(";")[0]!;
  }

  async function signUp(email: string, password = "first-password-1") {
    const response = await request("/api/auth/sign-up/email", {
      body: { email, name: "Test Person", password },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { user: { id: string } };
    createdUsers.push(body.user.id);
    return { cookie: sessionCookie(response), userId: body.user.id };
  }

  async function signIn(email: string, password: string): Promise<string> {
    const response = await request("/api/auth/sign-in/email", { body: { email, password } });
    expect(response.status).toBe(200);
    return sessionCookie(response);
  }

  async function isVerified(userId: string): Promise<boolean> {
    const [row] = await query<{ email_verified: boolean }>(
      `select email_verified from "user" where id = $1`,
      [userId],
    );
    return row!.email_verified;
  }

  // A workspace the person belongs to, with one of each bearer credential
  // they can hold for it.
  async function grantCredentials(userId: string, email: string) {
    const db = getDatabase();
    const organizationId = randomUUID();
    const createdAt = new Date();
    await db.insert(organization).values({ createdAt, id: organizationId, name: "Acme", slug: organizationId });
    createdOrganizations.push(organizationId);
    await db.insert(member).values({ createdAt, organizationId, role: "admin", userId });
    const [current] = await query<{ id: string }>(
      "select id from session where user_id = $1 order by created_at limit 1",
      [userId],
    );
    const { token: apiKey } = await createApiKey({
      name: "CI",
      organizationId,
      sessionId: current!.id,
      user: { email, id: userId, name: "Test Person" },
    });
    const clientId = `client-${randomUUID()}`;
    await db.insert(oauthClient).values({ clientId, name: "Claude Code", redirectUris: ["http://localhost/callback"] });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const [refresh] = await db
      .insert(oauthRefreshToken)
      .values({
        clientId,
        createdAt,
        expiresAt,
        referenceId: organizationId,
        scopes: ["mcp"],
        token: hashOAuthAccessToken(`refresh-${randomUUID()}`),
        userId,
      })
      .returning({ id: oauthRefreshToken.id });
    await db.insert(oauthAccessToken).values({
      clientId,
      createdAt,
      expiresAt,
      referenceId: organizationId,
      refreshId: refresh!.id,
      scopes: ["mcp"],
      token: hashOAuthAccessToken(`access-${randomUUID()}`),
      userId,
    });
    await db.insert(oauthConsent).values({
      clientId,
      createdAt,
      referenceId: organizationId,
      scopes: ["mcp"],
      updatedAt: createdAt,
      userId,
    });
    return { apiKey };
  }

  async function liveCredentials(userId: string, apiKey: string) {
    const count = async (table: string, live: string) => {
      const [row] = await query<{ count: number }>(
        `select count(*)::int as count from ${table} where user_id = $1 and ${live}`,
        [userId],
      );
      return row!.count;
    };
    return {
      apiKey: (await authenticateApiKey(apiKey)) !== null,
      accessTokens: await count("oauth_access_token", "revoked is null"),
      consents: await count("oauth_consent", "true"),
      refreshTokens: await count("oauth_refresh_token", "revoked is null"),
    };
  }

  async function sessionCount(userId: string): Promise<number> {
    const [row] = await query<{ count: number }>(
      "select count(*)::int as count from session where user_id = $1",
      [userId],
    );
    return row!.count;
  }

  const allRevoked = { accessTokens: 0, apiKey: false, consents: 0, refreshTokens: 0 };

  describe("password reset", () => {
    it("revokes the person's API keys and app connections", async () => {
      const email = `reset-${randomUUID()}@example.com`;
      const { userId } = await signUp(email);
      const { apiKey } = await grantCredentials(userId, email);
      expect(await liveCredentials(userId, apiKey)).toEqual({
        accessTokens: 1,
        apiKey: true,
        consents: 1,
        refreshTokens: 1,
      });

      const token = randomUUID();
      await getDatabase().insert(verification).values({
        expiresAt: new Date(Date.now() + 60_000),
        id: randomUUID(),
        identifier: `reset-password:${token}`,
        value: userId,
      });
      const response = await request("/api/auth/reset-password", {
        body: { newPassword: "second-password-2", token },
      });

      expect(response.status).toBe(200);
      expect(await liveCredentials(userId, apiKey)).toEqual(allRevoked);
      expect(await sessionCount(userId)).toBe(0);
    });

    it("confirms the email, since only its owner receives the reset link", async () => {
      const email = `reset-verify-${randomUUID()}@example.com`;
      const { userId } = await signUp(email);
      const token = randomUUID();
      await getDatabase().insert(verification).values({
        expiresAt: new Date(Date.now() + 60_000),
        id: randomUUID(),
        identifier: `reset-password:${token}`,
        value: userId,
      });

      await request("/api/auth/reset-password", { body: { newPassword: "second-password-2", token } });

      expect(await isVerified(userId)).toBe(true);
    });
  });

  describe("password change", () => {
    it("revokes API keys, app connections, and other sessions, keeping the current one", async () => {
      const email = `change-${randomUUID()}@example.com`;
      const { cookie, userId } = await signUp(email);
      await signIn(email, "first-password-1");
      const { apiKey } = await grantCredentials(userId, email);
      expect(await sessionCount(userId)).toBe(2);

      const response = await request("/api/auth/change-password", {
        body: { currentPassword: "first-password-1", newPassword: "second-password-2" },
        cookie,
      });

      expect(response.status).toBe(200);
      expect(await liveCredentials(userId, apiKey)).toEqual(allRevoked);
      expect(await sessionCount(userId)).toBe(1);
      const current = await request("/api/auth/get-session", { cookie });
      expect(await current.json()).toMatchObject({ user: { id: userId } });
    });

    it("leaves credentials alone when the current password is wrong", async () => {
      const email = `change-wrong-${randomUUID()}@example.com`;
      const { cookie, userId } = await signUp(email);
      const { apiKey } = await grantCredentials(userId, email);

      const response = await request("/api/auth/change-password", {
        body: { currentPassword: "not-the-password", newPassword: "second-password-2" },
        cookie,
      });

      expect(response.status).toBe(400);
      expect((await liveCredentials(userId, apiKey)).apiKey).toBe(true);
    });
  });

  describe("API key creation", () => {
    // A request that signed in before a reset must not add a key after the
    // reset ended its session.
    it("refuses a key for a session that has ended", async () => {
      const email = `ended-${randomUUID()}@example.com`;
      const { userId } = await signUp(email);
      const [current] = await query<{ id: string }>("select id from session where user_id = $1", [userId]);
      await query("delete from session where id = $1", [current!.id]);

      await expect(
        createApiKey({
          name: "CI",
          organizationId: randomUUID(),
          sessionId: current!.id,
          user: { email, id: userId, name: "Test Person" },
        }),
      ).rejects.toThrow("The session has ended");
    });
  });

  describe("ban", () => {
    it("revokes the banned person's API keys, app connections, and sessions", async () => {
      const { userId: supportId } = await signUp(superuserEmail, "support-password-1");
      await query(`update "user" set email_verified = true where id = $1`, [supportId]);
      const supportCookie = await signIn(superuserEmail, "support-password-1");

      const email = `ban-${randomUUID()}@example.com`;
      const { userId } = await signUp(email);
      const { apiKey } = await grantCredentials(userId, email);

      const response = await request("/api/auth/admin/ban-user", {
        body: { banReason: "test", userId },
        cookie: supportCookie,
      });

      expect(response.status).toBe(200);
      expect(await liveCredentials(userId, apiKey)).toEqual(allRevoked);
      expect(await sessionCount(userId)).toBe(0);
    });

    it("refuses the API key of a person banned outside Better Auth", async () => {
      const email = `ban-sql-${randomUUID()}@example.com`;
      const { userId } = await signUp(email);
      const { apiKey } = await grantCredentials(userId, email);

      await query(`update "user" set banned = true where id = $1`, [userId]);
      expect(await authenticateApiKey(apiKey)).toBeNull();

      await query(`update "user" set ban_expires = now() - interval '1 second' where id = $1`, [
        userId,
      ]);
      expect(await authenticateApiKey(apiKey)).not.toBeNull();
    });
  });

  describe("email confirmation", () => {
    function confirmationPath(): string {
      const message = sentEmails.at(-1);
      const match = /https?:\/\/[^\s"'<>]+\/verify-email\?[^\s"'<>]+/u.exec(
        `${message?.text ?? ""} ${message?.html ?? ""}`,
      );
      if (!match) throw new Error("no confirmation link sent");
      const url = new URL(match[0].replaceAll("&amp;", "&"));
      return `${url.pathname}${url.search}`;
    }

    it("does not send a confirmation link to an address without a signed-in session", async () => {
      const email = `owner-${randomUUID()}@example.com`;
      await signUp(email);

      const response = await request("/api/auth/send-verification-email", { body: { email } });

      expect(response.status).toBe(401);
      expect(sentEmails).toHaveLength(0);
    });

    it("does not confirm the account when the link is opened without its session", async () => {
      const email = `owner-${randomUUID()}@example.com`;
      const { cookie, userId } = await signUp(email);
      await request("/api/auth/send-verification-email", {
        body: { callbackURL: "/invite/abc", email },
        cookie,
      });

      const response = await request(confirmationPath());

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain("error=");
      expect(await isVerified(userId)).toBe(false);
    });

    it("does not confirm the account from another account's session", async () => {
      const email = `owner-${randomUUID()}@example.com`;
      const { cookie, userId } = await signUp(email);
      const other = await signUp(`other-${randomUUID()}@example.com`);
      await request("/api/auth/send-verification-email", {
        body: { callbackURL: "/invite/abc", email },
        cookie,
      });

      await request(confirmationPath(), { cookie: other.cookie });

      expect(await isVerified(userId)).toBe(false);
    });

    it("confirms the account when opened in the browser signed in to it", async () => {
      const email = `owner-${randomUUID()}@example.com`;
      const { cookie, userId } = await signUp(email);
      await request("/api/auth/send-verification-email", {
        body: { callbackURL: "/invite/abc", email },
        cookie,
      });

      const response = await request(confirmationPath(), { cookie });

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/invite/abc");
      expect(await isVerified(userId)).toBe(true);
    });
  });
});
