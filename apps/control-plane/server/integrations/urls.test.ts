import { afterEach, describe, expect, it, vi } from "vitest";
import { integrationCallbackUrl, settingsRedirect } from "./urls";

describe("integration URLs", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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
});
