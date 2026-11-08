import { EnvelopeIcon } from "@phosphor-icons/react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { authErrorCode } from "../auth-error-code";
import { authClient } from "../auth-client";
import { AppShell } from "../components/app-shell";
import { SettingsHeading } from "../components/settings-heading";
import { MemberListSkeleton } from "../components/screen-skeletons";
import { SelectField, Switch, TextAreaField, type SelectOption } from "../design-system";
import { useDocumentTitle } from "../use-document-title";
import { useOrganizationCapabilities } from "../organization-capabilities";
import {
  teamPlanDescription,
  teamPlanRequiredCode,
  teammatePlan,
  type TeamPlan,
} from "./workspace-settings-presentation";

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

interface PullRequestAuthorState {
  appLogin: string | null;
  author: {
    githubLogin: string;
    status: "connected" | "error";
    user: { id: string; name: string };
  } | null;
  canRemove: boolean;
}

const pullRequestAuthorErrors: Record<string, string> = {
  cancelled: "GitHub authorization was cancelled.",
  no_shared_installation:
    "Your GitHub account cannot access the GitHub installation connected to this workspace.",
};

function invitationUrl(invitationId: string): string {
  return `${window.location.origin}/invite/${invitationId}`;
}

interface WorkspaceBilling {
  automations: { plans: TeamPlan[] } | null;
  invitationsNeedTeamPlan?: boolean;
}

export function WorkspaceSettingsPage() {
  useDocumentTitle("Workspace settings");
  const signal = useOrganizationCapabilities().includes("signal");
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
  const [needsTeamPlan, setNeedsTeamPlan] = useState(false);
  const [teamPlan, setTeamPlan] = useState<TeamPlan | null>(null);

  useEffect(() => {
    if (signal || !isAdmin || !organizationId) return;
    let active = true;
    // Without the billing summary the form stays, and a refused invitation
    // still offers Team.
    void fetch("/api/billing")
      .then(async (response) =>
        response.ok ? ((await response.json()) as WorkspaceBilling) : null)
      .then((billing) => {
        if (!active || !billing) return;
        setNeedsTeamPlan(billing.invitationsNeedTeamPlan === true);
        setTeamPlan(teammatePlan(billing));
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [signal, isAdmin, organizationId]);

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
      if (result.error?.code === teamPlanRequiredCode) {
        setNeedsTeamPlan(true);
        return;
      }
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
    <AppShell active="settings" density="settings" redesigned>
      <SettingsHeading active="workspace" />

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

        {isAdmin && needsTeamPlan ? (
          <section aria-labelledby="team-plan-offer" className="inviteForm teamPlanOffer">
            <div>
              <h3 id="team-plan-offer">Invite teammates on the Team plan</h3>
              <p>{teamPlanDescription(teamPlan)}</p>
            </div>
            <div className="inviteForm__controls">
              <Link className="button button--primary" to="/settings/billing#plans">
                {teamPlan ? `Upgrade to ${teamPlan.name}` : "See plans"}
              </Link>
            </div>
          </section>
        ) : isAdmin ? (
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
                  <span className="memberAvatar memberAvatar--pending"><EnvelopeIcon size={16} aria-hidden="true" /></span>
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

        {!signal && <>
          <PullRequestAuthorSection currentUserId={session.data?.user.id} />
          <SandboxImageSection />
          <SandboxNetworkSection />
        </>}
      </section>
    </AppShell>
  );
}

// Chooses whose GitHub account opens the workspace's pull requests. Review
// bots that bill per pull request author then count a seat the workspace
// already pays for, instead of a seat for the GitHub App.
function PullRequestAuthorSection({ currentUserId }: { currentUserId: string | undefined }) {
  const [state, setState] = useState<PullRequestAuthorState | null>(null);
  const [removing, setRemoving] = useState(false);
  // GitHub authorization returns here with its outcome in the address.
  const [returned] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("integration") === "github"
      ? { reason: params.get("reason") ?? "", status: params.get("status") }
      : null;
  });
  const [error, setError] = useState<string | null>(() =>
    returned?.status === "error"
      ? pullRequestAuthorErrors[returned.reason] ?? "Could not connect your GitHub account."
      : null,
  );
  const [notice, setNotice] = useState<string | null>(() =>
    returned?.status === "connected"
      ? "Your GitHub account now opens pull requests."
      : null,
  );

  async function load() {
    const response = await fetch("/api/integrations/github/pull-request-author");
    if (!response.ok) throw new Error("Could not load the pull request author");
    return (await response.json()) as PullRequestAuthorState;
  }

  useEffect(() => {
    if (returned) window.history.replaceState(null, "", window.location.pathname);
    load().then(setState, (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "Could not load the pull request author");
    });
  }, [returned]);

  async function remove() {
    setError(null);
    setNotice(null);
    setRemoving(true);
    try {
      const response = await fetch("/api/integrations/github/pull-request-author", {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not change the pull request author");
      }
      setState(await load());
      setNotice("The GitHub App now opens pull requests.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change the pull request author");
    } finally {
      setRemoving(false);
    }
  }

  const author = state?.author ?? null;
  const isCurrentUser = author?.user.id === currentUserId;
  const connectUrl = "/api/integrations/github/pull-request-author/start?returnTo=/settings/workspace";

  return (
    <div className="memberSection">
      <div className="memberSection__heading">
        <h3>Pull requests</h3>
      </div>
      <p className="memberAccessNote">
        The GitHub App opens pull requests unless a member's account is
        chosen here. Review bots that bill per pull request author
        then count that member's seat. When the member cannot push to a
        repository, the GitHub App opens the pull request instead.
      </p>
      {error ? <p className="settingsNotice settingsNotice--error">{error}</p> : null}
      {notice ? <p className="settingsNotice settingsNotice--success">{notice}</p> : null}
      {state ? (
        <div className="memberList">
          <div className="memberRow">
            <span className="memberAvatar">
              {author ? initials(author.githubLogin) : "GH"}
            </span>
            <span className="memberIdentity">
              <strong>
                {author
                  ? `@${author.githubLogin}`
                  : state.appLogin ? `@${state.appLogin}` : "GitHub App"}
                {isCurrentUser ? <small>You</small> : null}
              </strong>
              <span>
                {author
                  ? author.status === "error"
                    ? `GitHub no longer accepts ${author.user.name}'s authorization. The GitHub App opens pull requests until a member connects again.`
                    : `${author.user.name}'s GitHub account opens pull requests.`
                  : "The GitHub App opens pull requests as its bot account."}
              </span>
            </span>
            <span className="roleLabel">
              {author?.status === "error" ? "Reconnect" : author ? "Connected" : "Default"}
            </span>
            <span className="invitationActions">
              {!author || !isCurrentUser || author.status === "error" ? (
                <a className="memberAction" href={connectUrl}>
                  {isCurrentUser ? "Reconnect" : "Use my account"}
                </a>
              ) : null}
              {author && state.canRemove ? (
                <button
                  className="memberAction memberAction--danger"
                  disabled={removing}
                  onClick={() => void remove()}
                  type="button"
                >
                  {removing ? "Stopping…" : "Use the app"}
                </button>
              ) : null}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type SandboxImageBuildState = "building" | "failed" | "none" | "queued" | "ready";

interface SandboxImageSettingsValue {
  installDependencies: boolean;
  packages: string[];
  setupScript: string;
  startCommand: string;
  vcpus: number;
}

interface SandboxImageState {
  canEdit: boolean;
  image: {
    builtAt: string | null;
    error: string | null;
    finishedAt: string | null;
    log: string;
    startedAt: string | null;
    state: SandboxImageBuildState;
  };
  memoryGiBPerVcpu: number;
  settings: SandboxImageSettingsValue;
  supported: boolean;
  vcpuOptions: number[];
}

function packageList(text: string): string[] {
  return text.split(/\s+/u).map((name) => name.trim()).filter(Boolean);
}

function formattedTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "";
}

function sandboxImageStatus(image: SandboxImageState["image"]): {
  text: string;
  tone: "error" | "success" | "warning" | null;
} | null {
  const fallback = image.builtAt
    ? "runs use the last image that built and its start command, or the default image without a start command if Superlog has updated it since."
    : "runs use the default image without a start command.";
  const meanwhile = `Until it finishes, ${fallback}`;
  switch (image.state) {
    case "none":
      return null;
    case "queued":
      return { text: `Build queued. ${meanwhile}`, tone: "warning" };
    case "building":
      return {
        text: `Building since ${formattedTime(image.startedAt)}. ${meanwhile}`,
        tone: "warning",
      };
    case "failed":
      return {
        text: `Build failed: ${image.error ?? "unknown error"}. Until a build succeeds, ${fallback}`,
        tone: "error",
      };
    case "ready":
      return { text: `Image ready, built ${formattedTime(image.builtAt)}.`, tone: "success" };
  }
}

async function fetchSandboxImageState(): Promise<SandboxImageState> {
  const response = await fetch("/api/sandbox-settings");
  if (!response.ok) throw new Error("Could not load the sandbox settings");
  return (await response.json()) as SandboxImageState;
}

// Adds system packages and a setup script to the workspace's sandboxes, built
// once into an image, plus a command for every sandbox start, whether to
// install repository dependencies after checkout, and the sandbox size.
function SandboxImageSection() {
  const [state, setState] = useState<SandboxImageState | null>(null);
  const [packages, setPackages] = useState("");
  const [setupScript, setSetupScript] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [vcpus, setVcpus] = useState("2");
  const [installDependencies, setInstallDependencies] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function show(next: SandboxImageState) {
    setState(next);
    setPackages(next.settings.packages.join("\n"));
    setSetupScript(next.settings.setupScript);
    setStartCommand(next.settings.startCommand);
    setVcpus(String(next.settings.vcpus));
    setInstallDependencies(next.settings.installDependencies);
  }

  useEffect(() => {
    fetchSandboxImageState()
      .then(show)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not load the sandbox settings");
      });
  }, []);

  const buildState = state?.image.state;
  // Counts saves, so a poll that started before one cannot overwrite its result.
  const saveCount = useRef(0);
  // Follows a build until it finishes, without touching unsaved edits.
  useEffect(() => {
    if (buildState !== "queued" && buildState !== "building") return;
    const timer = setInterval(() => {
      const startedAfter = saveCount.current;
      fetchSandboxImageState()
        .then((next) => {
          if (!saving && saveCount.current === startedAfter) setState(next);
        })
        .catch(() => undefined);
    }, 5_000);
    return () => clearInterval(timer);
  }, [buildState, saving]);

  async function send(path: string, method: string, body?: unknown) {
    setError(null);
    setSaving(true);
    saveCount.current += 1;
    try {
      const response = await fetch(path, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: { "content-type": "application/json" },
        method,
      });
      const result = (await response.json().catch(() => null)) as
        | (SandboxImageState & { error?: string })
        | null;
      if (!response.ok || !result) {
        throw new Error(result?.error ?? "Could not save the sandbox settings");
      }
      show(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the sandbox settings");
    } finally {
      setSaving(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send("/api/sandbox-settings", "PUT", {
      installDependencies,
      packages: packageList(packages),
      setupScript,
      startCommand,
      vcpus: Number(vcpus),
    });
  }

  const canEdit = (state?.canEdit ?? false) && (state?.supported ?? false);
  const changed = state !== null && (
    packageList(packages).join("\n") !== state.settings.packages.join("\n") ||
    setupScript.trim() !== state.settings.setupScript ||
    startCommand.trim() !== state.settings.startCommand ||
    Number(vcpus) !== state.settings.vcpus ||
    installDependencies !== state.settings.installDependencies
  );
  const status = state ? sandboxImageStatus(state.image) : null;
  const vcpuOptions: Array<SelectOption<string>> = (state?.vcpuOptions ?? [2]).map((count) => ({
    label: `${count} vCPUs, ${count * (state?.memoryGiBPerVcpu ?? 2)} GB memory`,
    value: String(count),
  }));

  return (
    <form className="memberSection" onSubmit={save}>
      <div className="memberSection__heading">
        <h3>Sandbox</h3>
      </div>
      <p className="memberAccessNote">
        Agents run commands in a sandbox on Amazon Linux 2023 with Node.js,
        Python, git, and the agent tools. Add what your repositories need to
        build and test, such as browsers or databases. Packages and the setup
        script are built into an image once, so runs start with them. Changes
        to them apply to new runs when the image is ready.
        {state && !state.supported
          ? " These settings need the Vercel sandbox provider."
          : state && !state.canEdit ? " Admins can change this." : null}
      </p>
      {error ? <p className="settingsNotice settingsNotice--error">{error}</p> : null}
      {status ? (
        <p className={`settingsNotice${status.tone ? ` settingsNotice--${status.tone}` : ""}`}>
          {status.text}
        </p>
      ) : null}
      {state ? (
        <>
          <TextAreaField
            className="sandboxSettings__code"
            disabled={!canEdit || saving}
            hint="dnf package names, one per line, installed with sudo dnf install."
            label="Packages"
            onChange={(event) => setPackages(event.target.value)}
            placeholder={"postgresql16-server\nvalkey"}
            rows={4}
            spellCheck={false}
            value={packages}
          />
          <TextAreaField
            className="sandboxSettings__code"
            disabled={!canEdit || saving}
            hint="Runs with bash after the packages install, as the sandbox user, who can use sudo. It stops at the first failing command."
            label="Setup script"
            onChange={(event) => setSetupScript(event.target.value)}
            placeholder={"curl -LsSf https://astral.sh/uv/install.sh | sh\nnpx -y playwright install chromium"}
            rows={8}
            spellCheck={false}
            value={setupScript}
          />
          <TextAreaField
            className="sandboxSettings__code"
            disabled={!canEdit || saving}
            hint="Runs with bash each time a sandbox starts or resumes, before the agent. Use it for services, such as sudo dockerd &. With packages or a setup script, it is part of the image and changes when the image is ready. Without them, it applies right away. A failure stops the run."
            label="Start command"
            onChange={(event) => setStartCommand(event.target.value)}
            placeholder="sudo dockerd >/tmp/dockerd.log 2>&1 &"
            rows={3}
            spellCheck={false}
            value={startCommand}
          />
          <Switch
            checked={installDependencies}
            description="After checkout, installs each repository's dependencies from its lockfiles, such as with npm ci or uv sync, so agents can run tests. A failed install does not stop the run."
            disabled={!canEdit || saving}
            label="Install repository dependencies"
            onCheckedChange={setInstallDependencies}
          />
          <SelectField
            disabled={!canEdit || saving}
            hint="Larger sandboxes use more machine hours."
            label="Size"
            name="vcpus"
            onChange={setVcpus}
            options={vcpuOptions}
            value={vcpus}
          />
          {state.image.log ? (
            <details className="sandboxSettings__log">
              <summary>Build output</summary>
              <pre>{state.image.log}</pre>
            </details>
          ) : null}
          {canEdit ? (
            <div className="sandboxSettings__actions">
              <button
                className="button button--primary"
                disabled={!changed || saving}
                type="submit"
              >
                {saving ? "Saving…" : "Save"}
              </button>
              {state.image.state === "failed" || state.image.state === "ready" ? (
                <button
                  className="button button--secondary"
                  disabled={changed || saving}
                  onClick={() => void send("/api/sandbox-settings/rebuild", "POST")}
                  type="button"
                >
                  Rebuild image
                </button>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </form>
  );
}

interface SandboxNetworkState {
  alwaysAllowed: string[];
  canEdit: boolean;
  settings: { allowedDomains: string[]; restricted: boolean };
}

function domainList(text: string): string[] {
  return text.split(/[\s,]+/u).map((domain) => domain.trim()).filter(Boolean);
}

// Limits where the workspace's agents can send data from their sandbox, which
// is on by default. Superlog's host and each secret's hosts stay reachable, so
// runs keep working with an empty list.
function SandboxNetworkSection() {
  const [state, setState] = useState<SandboxNetworkState | null>(null);
  const [restricted, setRestricted] = useState(false);
  const [domains, setDomains] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function show(next: SandboxNetworkState) {
    setState(next);
    setRestricted(next.settings.restricted);
    setDomains(next.settings.allowedDomains.join("\n"));
  }

  useEffect(() => {
    fetch("/api/sandbox-network")
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load the sandbox network settings");
        show((await response.json()) as SandboxNetworkState);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Could not load the sandbox network settings");
      });
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setSaving(true);
    try {
      const response = await fetch("/api/sandbox-network", {
        body: JSON.stringify({ allowedDomains: domainList(domains), restricted }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const body = (await response.json().catch(() => null)) as
        | (SandboxNetworkState & { error?: string })
        | null;
      if (!response.ok || !body) {
        throw new Error(body?.error ?? "Could not save the sandbox network settings");
      }
      show(body);
      setNotice(
        restricted
          ? "Sandboxes now reach only the listed domains. Runs already in progress keep their current access until their next turn."
          : "Sandboxes now have open internet access.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the sandbox network settings");
    } finally {
      setSaving(false);
    }
  }

  const canEdit = state?.canEdit ?? false;
  const changed = state !== null && (
    restricted !== state.settings.restricted ||
    domainList(domains).join("\n") !== state.settings.allowedDomains.join("\n")
  );
  const alwaysAllowed = state?.alwaysAllowed.join(", ") ?? "Superlog";

  return (
    <form className="memberSection" onSubmit={(event) => void save(event)}>
      <div className="memberSection__heading">
        <h3>Sandbox network</h3>
      </div>
      <p className="memberAccessNote">
        Agents run commands in a sandbox.
        {state?.settings.restricted === false
          ? " It can reach any address on the internet. Restrict it to a list of domains to stop an agent sending data anywhere else."
          : " It reaches only the listed domains, so an agent cannot send data anywhere else. Turn this off to give it open internet access."}
        {" "}{alwaysAllowed} and the hosts of each secret a run uses stay
        reachable.
        {canEdit ? null : " Admins can change this."}
      </p>
      {error ? <p className="settingsNotice settingsNotice--error">{error}</p> : null}
      {notice ? <p className="settingsNotice settingsNotice--success">{notice}</p> : null}
      {state ? (
        <>
          <Switch
            checked={restricted}
            description="Applies to each automation turn, investigation, and pull request that starts after you save."
            disabled={!canEdit || saving}
            label="Only allow listed domains"
            onCheckedChange={setRestricted}
          />
          {restricted ? (
            <TextAreaField
              disabled={!canEdit || saving}
              hint="One domain per line. *.example.com covers example.com and its subdomains. The starting list covers common package registries, their installers, and GitHub."
              label="Allowed domains"
              onChange={(event) => setDomains(event.target.value)}
              placeholder={"registry.npmjs.org\n*.example.com"}
              rows={5}
              value={domains}
            />
          ) : null}
          {canEdit ? (
            <div>
              <button
                className="button button--primary"
                disabled={!changed || saving}
                type="submit"
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </form>
  );
}
