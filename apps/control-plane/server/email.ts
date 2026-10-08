import { escapeHtml } from "@responder/core/email";

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
