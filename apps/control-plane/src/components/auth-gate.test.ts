import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "./auth-gate";

const session = vi.hoisted(() => ({ data: null as unknown }));

vi.mock("../auth-client", () => ({
  authClient: { useSession: () => ({ data: session.data, isPending: false }) },
}));
vi.mock("../color-theme", () => ({
  useColorTheme: () => ({ theme: "light", toggleTheme: vi.fn() }),
}));

function renderSignIn(path = "/app") {
  vi.stubGlobal("window", { location: new URL(path, "https://example.com") });
  return renderToStaticMarkup(createElement(AuthGate, { children: null }));
}

describe("signed-out authentication", () => {
  beforeEach(() => vi.stubGlobal("sessionStorage", { getItem: () => null }));
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the password masked and gives its visibility control an accessible name", () => {
    const html = renderSignIn();
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toMatch(/<button[^>]*type="button"[^>]*aria-label="Show password"[^>]*aria-pressed="false"/);
    expect(html).toContain('type="submit"');
    expect(html).toContain("Sign in to manage your agents and investigations.");
    expect(html).toContain('<label for="auth-password">Enter your password</label>');
    expect(html).toContain('id="auth-password"');
    for (const label of html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)) {
      expect(label[0]).not.toContain("<button");
    }
  });

  it("starts on account creation for sign-up links and automation templates", () => {
    for (const path of [
      "/app?signup=1",
      "/automations/new?signup=1",
      "/automations/new?template=triage-sentry-issues",
      "/automations/new?shared=aB3_-xYz09aB3_-x",
    ]) {
      const html = renderSignIn(path);
      expect(html).toContain("Create account");
      expect(html).toContain('autoComplete="new-password"');
    }
  });

  it("starts on sign-in for a plain visit", () => {
    for (const path of ["/app", "/automations/new", "/agents/new?template=triage-sentry-issues"]) {
      expect(renderSignIn(path)).toContain("Welcome back");
    }
  });

  it("preserves invitation guidance while exposing sign-up and policy links", () => {
    const html = renderSignIn("/invite/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(html).toContain("Workspace invitation");
    expect(html).toContain("invited email");
    expect(html).toContain("Get started");
    expect(html).toContain('href="/tos"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain("Continue with Google");
    expect(html).toContain("Continue with GitHub");
  });
});

describe("workspace invitation", () => {
  const invitationPath = "/invite/11111111-1111-4111-8111-111111111111";

  function signedInAs(emailVerified: boolean) {
    session.data = {
      session: { activeOrganizationId: null },
      user: { email: "ada@example.com", emailVerified, id: "user-1" },
    };
  }

  beforeEach(() => vi.stubGlobal("sessionStorage", { getItem: () => null }));
  afterEach(() => {
    session.data = null;
    vi.unstubAllGlobals();
  });

  it("asks an unverified account to confirm its email before joining", () => {
    signedInAs(false);
    const html = renderSignIn(invitationPath);
    expect(html).toContain("Confirm your email");
    expect(html).toContain("confirm that you own ada@example.com");
    expect(html).toContain("Email me a link");
    expect(html).not.toContain("Accept invitation");
  });

  it("explains an expired confirmation link", () => {
    signedInAs(false);
    const html = renderSignIn(`${invitationPath}?error=TOKEN_EXPIRED`);
    expect(html).toContain("That confirmation link is invalid or expired.");
  });

  it("lets a verified account accept", () => {
    signedInAs(true);
    const html = renderSignIn(invitationPath);
    expect(html).toContain("Accept invitation");
    expect(html).not.toContain("Confirm your email");
  });
});
