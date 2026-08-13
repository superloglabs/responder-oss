import { describe, expect, it } from "vitest";
import { socialAuthErrorMessage, socialAuthUrls } from "./social-auth-url.js";

describe("social auth return URLs", () => {
  it("removes stale callback state while preserving application parameters", () => {
    const urls = socialAuthUrls(
      "https://responder.example/app?twclid=tracking&error=email_not_found&error=email_not_found&error_description=missing&signed_up=1",
    );

    expect(urls.callbackURL).toBe(
      "https://responder.example/app?twclid=tracking",
    );
    expect(urls.errorCallbackURL).toBe(
      "https://responder.example/app?twclid=tracking",
    );
    expect(urls.newUserCallbackURL).toBe(
      "https://responder.example/app?twclid=tracking&signed_up=1",
    );
  });
});

describe("social auth error messages", () => {
  it("explains a missing GitHub email", () => {
    expect(socialAuthErrorMessage("?error=email_not_found")).toContain(
      "an email address",
    );
  });

  it("uses a safe message for other provider errors", () => {
    expect(socialAuthErrorMessage("?error=invalid_code")).toBe(
      "Social sign in failed. Please try again.",
    );
    expect(socialAuthErrorMessage("")).toBeNull();
  });
});
