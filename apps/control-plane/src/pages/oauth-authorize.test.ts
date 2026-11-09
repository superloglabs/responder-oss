import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthAuthorizePage } from "./oauth-authorize";

const session = vi.hoisted(() => ({
  current: { data: null as unknown, error: null as unknown, isPending: false },
}));

vi.mock("../auth-client", () => ({
  authClient: { useSession: () => ({ ...session.current, refetch: vi.fn() }) },
}));
vi.mock("../use-document-title", () => ({ useDocumentTitle: () => undefined }));
vi.mock("../color-theme", () => ({
  useColorTheme: () => ({ theme: "light", toggleTheme: vi.fn() }),
}));

function renderPage() {
  vi.stubGlobal("window", {
    location: new URL("https://example.com/oauth/authorize?client_id=client-1&sig=signed"),
  });
  vi.stubGlobal("sessionStorage", { getItem: () => null });
  return renderToStaticMarkup(createElement(OAuthAuthorizePage));
}

describe("MCP authorization page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers a retry when the first session check fails", () => {
    session.current = { data: null, error: new Error("down"), isPending: false };
    const html = renderPage();
    expect(html).toContain("Could not reach Superlog");
    expect(html).toContain("Try again");
    expect(html).not.toContain('name="password"');
  });

  it("asks a signed-out visitor to sign in", () => {
    session.current = { data: null, error: null, isPending: false };
    expect(renderPage()).toContain('name="password"');
  });
});
