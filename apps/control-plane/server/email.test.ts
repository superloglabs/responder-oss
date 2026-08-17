import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEmail, workspaceInvitationEmailBody } from "./email.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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
      "Ada invited you to join the Acme workspace in Responder as a member.",
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

describe("sendEmail", () => {
  const message = {
    html: "<p>Invitation</p>",
    idempotencyKey: "workspace-invitation/invitation-id/1234",
    subject: "You're invited",
    text: "Invitation",
    to: "grace@example.com",
  };

  it("sends the configured Resend payload with an idempotency key", async () => {
    const deliver = vi.fn(async () => ({
      data: { id: "email-id" },
      error: null,
      headers: null,
    }));

    await sendEmail(message, {
      deliver,
      environment: {
        RESEND_API_KEY: "test-key",
        RESPONDER_FROM_EMAIL: "Responder <invite@example.com>",
        RESPONDER_REPLY_TO_EMAIL: "support@example.com",
      } as NodeJS.ProcessEnv,
    });

    expect(deliver).toHaveBeenCalledWith(
      {
        from: "Responder <invite@example.com>",
        html: message.html,
        replyTo: "support@example.com",
        subject: message.subject,
        text: message.text,
        to: [message.to],
      },
      { idempotencyKey: message.idempotencyKey },
    );
  });

  it("fails closed when production email is not configured", async () => {
    await expect(
      sendEmail(message, {
        environment: { NODE_ENV: "production" } as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow("RESEND_API_KEY is required");
  });

  it("keeps local invitation links usable without Resend", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    await sendEmail(message, { environment: {} as NodeJS.ProcessEnv });

    expect(warning).toHaveBeenCalledWith(
      JSON.stringify({
        event: "invitation_email_skipped",
        reason: "resend_not_configured",
      }),
    );
  });

  it("surfaces Resend delivery failures", async () => {
    const deliver = vi.fn(async () => ({
      data: null,
      error: {
        message: "Sender domain is not verified",
        name: "validation_error" as const,
        statusCode: 422,
      },
      headers: null,
    }));

    await expect(
      sendEmail(message, {
        deliver,
        environment: { RESEND_API_KEY: "test-key" } as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow("Sender domain is not verified");
  });
});
