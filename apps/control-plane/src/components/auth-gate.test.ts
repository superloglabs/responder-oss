import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "./auth-gate";

vi.mock("../auth-client", () => ({
  authClient: { useSession: () => ({ data: null, isPending: false }) },
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
