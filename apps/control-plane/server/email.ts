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

interface SendEmailOptions {
  deliver?: EmailDelivery;
  environment?: NodeJS.ProcessEnv;
}

export async function sendEmail(
  message: EmailMessage,
  options: SendEmailOptions = {},
): Promise<void> {
  const environment = options.environment ?? process.env;
  const apiKey = environment.RESEND_API_KEY?.trim();
  if (!apiKey) {
    if (environment.NODE_ENV === "production") {
      throw new Error("RESEND_API_KEY is required to send invitation emails");
    }
    console.warn(
      JSON.stringify({
        event: "invitation_email_skipped",
        reason: "resend_not_configured",
      }),
    );
    return;
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
    throw new Error(`Resend could not send the invitation: ${error.message}`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function workspaceInvitationEmailBody(args: {
  invitationUrl: string;
  inviterEmail: string;
  inviterName?: string | null;
  organizationName: string;
  role: string;
}): { html: string; text: string } {
  const inviter = args.inviterName?.trim() || args.inviterEmail;
  const safeInviter = escapeHtml(inviter);
  const safeOrganization = escapeHtml(args.organizationName);
  const safeRole = escapeHtml(args.role);
  const safeUrl = escapeHtml(args.invitationUrl);

  return {
    text: `${inviter} invited you to join the ${args.organizationName} workspace in Superlog as a ${args.role}.\n\nAccept invitation: ${args.invitationUrl}\n\nIf you weren't expecting this invitation, you can ignore this email.`,
    html: `<p>${safeInviter} invited you to join the <strong>${safeOrganization}</strong> workspace in Superlog as a ${safeRole}.</p>
<p><a href="${safeUrl}">Accept invitation</a></p>
<p style="color:#888">If you weren't expecting this invitation, you can ignore this email.</p>`,
  };
}
