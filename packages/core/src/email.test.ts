import { afterEach, describe, expect, it, vi } from "vitest";
import { escapeHtml, sendEmail } from "./email.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("escapeHtml", () => {
  it("escapes markup characters", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
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
        RESPONDER_FROM_EMAIL: "Superlog <invite@example.com>",
        RESPONDER_REPLY_TO_EMAIL: "support@example.com",
      } as NodeJS.ProcessEnv,
    });

    expect(deliver).toHaveBeenCalledWith(
      {
        from: "Superlog <invite@example.com>",
        html: message.html,
        replyTo: "support@example.com",
        subject: message.subject,
        text: message.text,
        to: [message.to],
      },
      { idempotencyKey: message.idempotencyKey },
    );
  });

  it("uses the default sender without a reply-to address", async () => {
    const deliver = vi.fn(async () => ({
      data: { id: "email-id" },
      error: null,
      headers: null,
    }));

    await expect(
      sendEmail(message, {
        deliver,
        environment: { RESEND_API_KEY: "test-key" } as NodeJS.ProcessEnv,
      }),
    ).resolves.toBe(true);

    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Superlog <no-reply@superlog.sh>",
        replyTo: undefined,
      }),
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

  it("skips local email without Resend", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      sendEmail(message, { environment: {} as NodeJS.ProcessEnv }),
    ).resolves.toBe(false);

    expect(warning).toHaveBeenCalledWith(
      JSON.stringify({
        event: "email_skipped",
        reason: "resend_not_configured",
        subject: message.subject,
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
