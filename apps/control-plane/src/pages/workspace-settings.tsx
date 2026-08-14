import { type FormEvent, useState } from "react";
import { authErrorCode } from "../auth-error-code";
import { authClient } from "../auth-client";
import { AppShell } from "../components/app-shell";
import { SettingsTabs } from "../components/settings-tabs";
import { MemberListSkeleton } from "../components/screen-skeletons";
import { SelectField, type SelectOption } from "../design-system";
import { useDocumentTitle } from "../use-document-title";

type WorkspaceRole = "admin" | "member";

const workspaceRoleOptions: Array<SelectOption<WorkspaceRole>> = [
  { label: "Member", value: "member" },
  { label: "Admin", value: "admin" },
];

interface WorkspaceMember {
  id: string;
  role: string;
  userId: string;
  user: {
    email: string;
    image?: string | null;
    name: string;
  };
}

interface WorkspaceInvitation {
  email: string;
  expiresAt: Date;
  id: string;
  role: string;
  status: string;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function invitationUrl(invitationId: string): string {
  return `${window.location.origin}/invite/${invitationId}`;
}

export function WorkspaceSettingsPage() {
  useDocumentTitle("Workspace settings");
  const session = authClient.useSession();
  const organization = authClient.useActiveOrganization();
  const activeMember = authClient.useActiveMember();
  const organizationId = session.data?.session.activeOrganizationId;
  const isAdmin = activeMember.data?.role.split(",").includes("admin") ?? false;
  const members = (organization.data?.members ?? []) as WorkspaceMember[];
  const invitations = (
    (organization.data?.invitations ?? []) as WorkspaceInvitation[]
  ).filter((invitation) => invitation.status === "pending");
  const [isInviting, setIsInviting] = useState(false);
  const [invitationRole, setInvitationRole] =
    useState<WorkspaceRole>("member");
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [latestInvitation, setLatestInvitation] = useState<string | null>(null);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organizationId) return;
    setError(null);
    setNotice(null);
    setLatestInvitation(null);
    setIsInviting(true);

    const form = event.currentTarget;
    const data = new FormData(form);
    const role = String(data.get("role") ?? "member") as WorkspaceRole;
    const result = await authClient.organization.inviteMember({
      email: String(data.get("email") ?? "").trim().toLowerCase(),
      role,
      organizationId,
    });
    setIsInviting(false);

    if (result.error || !result.data) {
      console.error(
        JSON.stringify({
          event: "workspace_invitation_creation",
          outcome: "failure",
          organizationId,
          role,
          errorCode: authErrorCode(result.error, "missing_data"),
        }),
      );
      setError(result.error?.message ?? "Could not create the invitation");
      return;
    }

    console.info(
      JSON.stringify({
        event: "workspace_invitation_creation",
        outcome: "success",
        organizationId,
        role,
      }),
    );
    const link = invitationUrl(result.data.id);
    setLatestInvitation(link);
    setNotice(
      `Invitation created for ${result.data.email}. Copy the link if they don't receive the email.`,
    );
    form.reset();
    setInvitationRole("member");
    await organization.refetch();
  }

  async function copyInvitation(idOrUrl: string) {
    const link = idOrUrl.startsWith("http")
      ? idOrUrl
      : invitationUrl(idOrUrl);
    try {
      await navigator.clipboard.writeText(link);
      setNotice("Invitation link copied.");
    } catch (clipboardError) {
      console.error(
        JSON.stringify({
          event: "invitation_copy_failed",
          organizationId,
          errorCode:
            clipboardError instanceof Error
              ? clipboardError.name
              : "unknown",
        }),
      );
      setError("Could not copy the invitation link");
    }
  }

  async function updateRole(memberId: string, role: WorkspaceRole) {
    if (!organizationId) return;
    setError(null);
    setNotice(null);
    setUpdatingId(memberId);
    const result = await authClient.organization.updateMemberRole({
      memberId,
      organizationId,
      role,
    });
    setUpdatingId(null);
    if (result.error) {
      console.error(
        JSON.stringify({
          event: "member_role_update_failed",
          memberId,
          organizationId,
          errorCode: authErrorCode(result.error),
        }),
      );
      setError(result.error.message ?? "Could not update the member role");
      return;
    }
    console.info(
      JSON.stringify({
        event: "member_role_update_success",
        memberId,
        organizationId,
        role,
      }),
    );
    setNotice("Member role updated.");
    await organization.refetch();
  }

  async function removeMember(member: WorkspaceMember) {
    if (!organizationId) return;
    const confirmed = window.confirm(
      `Remove ${member.user.name || member.user.email} from this workspace?`,
    );
    if (!confirmed) return;

    setError(null);
    setNotice(null);
    setUpdatingId(member.id);
    const result = await authClient.organization.removeMember({
      memberIdOrEmail: member.id,
      organizationId,
    });
    setUpdatingId(null);
    if (result.error) {
      console.error(
        JSON.stringify({
          event: "member_removal_failed",
          memberId: member.id,
          organizationId,
          errorCode: authErrorCode(result.error),
        }),
      );
      setError(result.error.message ?? "Could not remove the member");
      return;
    }
    console.info(
      JSON.stringify({
        event: "member_removal_success",
        memberId: member.id,
        organizationId,
        role: member.role,
      }),
    );
    setNotice("Member removed.");
    await organization.refetch();
  }

  async function cancelInvitation(invitationId: string) {
    setError(null);
    setNotice(null);
    setUpdatingId(invitationId);
    const result = await authClient.organization.cancelInvitation({
      invitationId,
    });
    setUpdatingId(null);
    if (result.error) {
      console.error(
        JSON.stringify({
          event: "invitation_cancellation_failed",
          invitationId,
          organizationId,
          errorCode: authErrorCode(result.error),
        }),
      );
      setError(result.error.message ?? "Could not cancel the invitation");
      return;
    }
    console.info(
      JSON.stringify({
        event: "invitation_cancellation_success",
        invitationId,
        organizationId,
      }),
    );
    setNotice("Invitation cancelled.");
    await organization.refetch();
  }

  return (
    <AppShell active="settings" density="settings">
      <section className="settingsHeading">
        <h1>Settings</h1>
        <p>Manage your workspace, members, and connected services.</p>
      </section>

      <SettingsTabs active="workspace" />

      <section className="workspaceSettings">
        <div className="workspaceSettings__intro">
          <span className="workspaceSettings__mark">
            {organization.data?.name.slice(0, 1).toUpperCase() ?? "W"}
          </span>
          <div>
            <h2>{organization.data?.name ?? "Workspace"}</h2>
            <p>
              {members.length} {members.length === 1 ? "member" : "members"} ·{" "}
              {organization.data?.slug}
            </p>
          </div>
        </div>

        {error ? <p className="settingsNotice settingsNotice--error">{error}</p> : null}
        {notice ? (
          <p className="settingsNotice settingsNotice--success">{notice}</p>
        ) : null}

        {isAdmin ? (
          <form className="inviteForm" onSubmit={invite}>
            <div>
              <h3>Invite a teammate</h3>
              <p>Email an invitation, with a secure link you can also copy.</p>
            </div>
            <div className="inviteForm__controls">
              <input
                aria-label="Email address"
                name="email"
                placeholder="teammate@company.com"
                required
                type="email"
              />
              <SelectField
                className="settingsRoleSelect settingsRoleSelect--invite"
                label="Invitation role"
                name="role"
                onChange={setInvitationRole}
                options={workspaceRoleOptions}
                value={invitationRole}
              />
              <button
                className="button button--primary"
                disabled={isInviting}
                type="submit"
              >
                {isInviting ? "Inviting…" : "Invite"}
              </button>
            </div>
            {latestInvitation ? (
              <div className="invitationLink">
                <input
                  aria-label="New invitation link"
                  readOnly
                  value={latestInvitation}
                />
                <button
                  className="button button--secondary"
                  onClick={() => void copyInvitation(latestInvitation)}
                  type="button"
                >
                  Copy link
                </button>
              </div>
            ) : null}
          </form>
        ) : (
          <p className="memberAccessNote">
            You are a member of this workspace. Admins can invite people and
            manage roles.
          </p>
        )}

        <div className="memberSection">
          <div className="memberSection__heading">
            <h3>Members</h3>
            <span>{members.length}</span>
          </div>
          {organization.isPending ? (
            <MemberListSkeleton />
          ) : (
            <div className="memberList">
              {members.map((member) => {
                const isCurrentUser = member.userId === session.data?.user.id;
                return (
                  <div className="memberRow" key={member.id}>
                    <span className="memberAvatar">
                      {member.user.image ? (
                        <img alt="" src={member.user.image} />
                      ) : (
                        initials(member.user.name || member.user.email)
                      )}
                    </span>
                    <span className="memberIdentity">
                      <strong>
                        {member.user.name}
                        {isCurrentUser ? <small>You</small> : null}
                      </strong>
                      <span>{member.user.email}</span>
                    </span>
                    {isAdmin ? (
                      <SelectField
                        className="settingsRoleSelect settingsRoleSelect--member"
                        disabled={updatingId === member.id}
                        label={`Role for ${member.user.name || member.user.email}`}
                        onChange={(role) => void updateRole(member.id, role)}
                        options={workspaceRoleOptions}
                        value={member.role.includes("admin") ? "admin" : "member"}
                      />
                    ) : (
                      <span className="roleLabel">
                        {member.role.includes("admin") ? "Admin" : "Member"}
                      </span>
                    )}
                    {isAdmin && !isCurrentUser ? (
                      <button
                        className="memberAction"
                        disabled={updatingId === member.id}
                        onClick={() => void removeMember(member)}
                        type="button"
                      >
                        Remove
                      </button>
                    ) : (
                      <span className="memberActionPlaceholder" />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {isAdmin && invitations.length > 0 ? (
          <div className="memberSection">
            <div className="memberSection__heading">
              <h3>Pending invitations</h3>
              <span>{invitations.length}</span>
            </div>
            <div className="memberList">
              {invitations.map((invitation) => (
                <div className="memberRow invitationRow" key={invitation.id}>
                  <span className="memberAvatar memberAvatar--pending">✉</span>
                  <span className="memberIdentity">
                    <strong>{invitation.email}</strong>
                    <span>
                      Expires{" "}
                      {new Intl.DateTimeFormat(undefined, {
                        dateStyle: "medium",
                      }).format(new Date(invitation.expiresAt))}
                    </span>
                  </span>
                  <span className="roleLabel">
                    {invitation.role === "admin" ? "Admin" : "Member"}
                  </span>
                  <span className="invitationActions">
                    <button
                      className="memberAction"
                      onClick={() => void copyInvitation(invitation.id)}
                      type="button"
                    >
                      Copy link
                    </button>
                    <button
                      className="memberAction memberAction--danger"
                      disabled={updatingId === invitation.id}
                      onClick={() => void cancelInvitation(invitation.id)}
                      type="button"
                    >
                      Cancel
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}
