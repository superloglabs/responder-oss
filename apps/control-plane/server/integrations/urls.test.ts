import { afterEach, describe, expect, it, vi } from "vitest";
import { cellCallbackUrl, integrationCallbackUrl, settingsRedirect } from "./urls";

describe("integration URLs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("names this cell's own address in OAuth state, from the cell list when there is one", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://sign-in.example");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://superlog.sh");
    vi.stubEnv("RESPONDER_CELLS", "");
    expect(cellCallbackUrl("slack")).toBe("https://sign-in.example/api/integrations/slack/callback");

    vi.stubEnv(
      "RESPONDER_CELLS",
      JSON.stringify([
        { id: "eu", label: "Europe", url: "https://superlog.sh" },
        { id: "us", label: "United States", url: "https://us.superlog.sh" },
      ]),
    );
    vi.stubEnv("RESPONDER_CELL_ID", "us");
    expect(cellCallbackUrl("slack")).toBe("https://us.superlog.sh/api/integrations/slack/callback");
  });

  it("uses the public tunnel for provider callbacks", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://branch.responder.localhost");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.ngrok.app");

    expect(integrationCallbackUrl("slack")).toBe(
      "https://responder.ngrok.app/api/integrations/slack/callback",
    );
    expect(integrationCallbackUrl("vercel")).toBe(
      "https://responder.ngrok.app/api/integrations/vercel/callback",
    );
  });

  it("returns users to the local worktree after a callback", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://branch.responder.localhost");
    vi.stubEnv("RESPONDER_PUBLIC_URL", "https://responder.ngrok.app");

    expect(settingsRedirect("/settings", "slack", "connected")).toBe(
      "https://branch.responder.localhost/settings?integration=slack&status=connected",
    );
  });

  it("rejects backslash-based cross-origin return paths", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://responder.example");

    expect(settingsRedirect("/\\evil.example", "slack", "connected")).toBe(
      "https://responder.example/settings?integration=slack&status=connected",
    );
  });
});
