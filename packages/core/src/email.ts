import {
  Resend,
  type CreateEmailOptions,
  type CreateEmailRequestOptions,
  type CreateEmailResponse,
} from "resend";

const defaultFrom = "Superlog <no-reply@superlog.sh>";

type EmailDelivery = (
  message: CreateEmailOptions,
  options?: CreateEmailRequestOptions,
) => Promise<CreateEmailResponse>;

export interface EmailMessage {
  html: string;
  idempotencyKey: string;
  subject: string;
  text: string;
  to: string;
}

export interface SendEmailOptions {
  deliver?: EmailDelivery;
  environment?: NodeJS.ProcessEnv;
}

// Resolves to false when email is not configured outside production, where
// it is skipped rather than sent.
export async function sendEmail(
  message: EmailMessage,
  options: SendEmailOptions = {},
): Promise<boolean> {
  const environment = options.environment ?? process.env;
  const apiKey = environment.RESEND_API_KEY?.trim();
  if (!apiKey) {
    if (environment.NODE_ENV === "production") {
      throw new Error("RESEND_API_KEY is required to send email");
    }
    console.warn(
      JSON.stringify({
        event: "email_skipped",
        reason: "resend_not_configured",
        subject: message.subject,
      }),
    );
    return false;
  }

  const deliver =
    options.deliver ??
    ((payload: CreateEmailOptions, requestOptions?: CreateEmailRequestOptions) => {
      const resend = new Resend(apiKey);
      return resend.emails.send(payload, requestOptions);
    });
  const { error } = await deliver(
    {
      from: environment.RESPONDER_FROM_EMAIL?.trim() || defaultFrom,
      html: message.html,
      replyTo: environment.RESPONDER_REPLY_TO_EMAIL?.trim() || undefined,
      subject: message.subject,
      text: message.text,
      to: [message.to],
    },
    { idempotencyKey: message.idempotencyKey },
  );

  if (error) {
    throw new Error(`Resend could not send the email: ${error.message}`);
  }
  return true;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
