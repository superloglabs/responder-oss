import { describe, expect, it } from "vitest";
import {
  passwordResetEmailBody,
  workspaceInvitationEmailBody,
} from "./email.js";

describe("workspaceInvitationEmailBody", () => {
  it("includes invitation context in both email formats", () => {
    const invitationUrl =
      "https://responder.superlog.sh/invite/11111111-1111-4111-8111-111111111111";
    const body = workspaceInvitationEmailBody({
      invitationUrl,
      inviterEmail: "ada@example.com",
      inviterName: "Ada",
      organizationName: "Acme",
      role: "member",
    });

    expect(body.text).toContain(
      "Ada invited you to join the Acme workspace in Superlog as a member.",
    );
    expect(body.text).toContain(`Accept invitation: ${invitationUrl}`);
    expect(body.html).toContain("<strong>Acme</strong>");
    expect(body.html).toContain(`href="${invitationUrl}"`);
  });

  it("escapes user-controlled values in the HTML body", () => {
    const body = workspaceInvitationEmailBody({
      invitationUrl: 'https://example.com/invite/a"><script>',
      inviterEmail: "ada@example.com",
      inviterName: "<b>Ada</b>",
      organizationName: '<img src="x">',
      role: "<admin>",
    });

    expect(body.html).not.toContain("<script>");
    expect(body.html).not.toContain("<b>Ada</b>");
    expect(body.html).not.toContain("<img");
    expect(body.html).toContain("&lt;b&gt;Ada&lt;/b&gt;");
    expect(body.html).toContain("&lt;admin&gt;");
    expect(body.html).toContain("&quot;");
  });
});

describe("passwordResetEmailBody", () => {
  it("links to the reset URL in both email formats", () => {
    const resetUrl =
      "https://responder.superlog.sh/api/auth/reset-password/abc?callbackURL=%2Freset-password";
    const body = passwordResetEmailBody({ resetUrl });

    expect(body.text).toContain(`Reset password: ${resetUrl}`);
    expect(body.html).toContain(
      'href="https://responder.superlog.sh/api/auth/reset-password/abc?callbackURL=%2Freset-password"',
    );
  });

  it("escapes the reset URL in the HTML body", () => {
    const body = passwordResetEmailBody({
      resetUrl: 'https://example.com/reset"><script>',
    });

    expect(body.html).not.toContain("<script>");
    expect(body.html).toContain("&quot;&gt;&lt;script&gt;");
  });
});
