import { type FormEvent, useEffect, useState } from "react";
import { authClient } from "../auth-client";
import { AuthFrame, SignIn } from "../components/auth-gate";
import { workspaceSlug } from "../components/workspace";
import {
  oauthAuthorizationRequest,
  oauthClientDisplayName,
  oauthErrorMessage,
  oauthNextUrl,
} from "../oauth-authorization";
import { useDocumentTitle } from "../use-document-title";

// Workspace changes on this page use plain fetch. The auth client adds the
// signed OAuth query to its requests here, and a request that sets the
// session cookie would continue the OAuth flow in its place.
async function postAuth(path: string, body: Record<string, unknown>) {
  const response = await fetch(`/api/auth${path}`, {
    body: JSON.stringify(body),
    credentials: "include",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(oauthErrorMessage(payload));
  return payload;
}

function useClientName(clientId: string): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch(
      `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
      { credentials: "include" },
    )
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
      .then((client: unknown) => {
        if (cancelled) return;
        setName(
          oauthClientDisplayName(
            (client as { client_name?: unknown } | null)?.client_name,
          ),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);
  return name;
}

function Consent({
  activeOrganizationId,
  clientId,
  email,
  redirectHost,
}: {
  activeOrganizationId: string | null;
  clientId: string;
  email: string;
  redirectHost: string | null;
}) {
  const clientName = useClientName(clientId);
  const organizations = authClient.useListOrganizations();
  const [selected, setSelected] = useState<string | null>(activeOrganizationId);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspaces = organizations.data ?? [];
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === selected) ??
    (workspaces.length === 1 ? workspaces[0] : undefined);

  async function decide(accept: boolean) {
    setError(null);
    setIsSubmitting(true);
    try {
      if (accept) {
        if (!selectedWorkspace) throw new Error("Choose a workspace");
        if (selectedWorkspace.id !== activeOrganizationId) {
          await postAuth("/organization/set-active", {
            organizationId: selectedWorkspace.id,
          });
        }
      }
      const result = await authClient.oauth2.consent({ accept });
      const nextUrl = oauthNextUrl(result.data);
      if (result.error || !nextUrl) {
        throw new Error(oauthErrorMessage(result.error));
      }
      console.info(
        JSON.stringify({
          event: accept ? "mcp_oauth_consent_granted" : "mcp_oauth_consent_denied",
          organizationId: accept ? selectedWorkspace?.id : undefined,
        }),
      );
      window.location.assign(nextUrl);
    } catch (cause) {
      setIsSubmitting(false);
      setError(cause instanceof Error ? cause.message : oauthErrorMessage(null));
    }
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const name = String(new FormData(event.currentTarget).get("organizationName") ?? "").trim();
    const slug = workspaceSlug(name);
    if (!slug) {
      setError("Use at least one letter or number in the workspace name");
      return;
    }
    setIsSubmitting(true);
    try {
      const created = (await postAuth("/organization/create", { name, slug })) as {
        id?: unknown;
      } | null;
      await organizations.refetch();
      if (typeof created?.id === "string") setSelected(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the workspace");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <div className="authIntro">
        <span className="invitationLabel oauthLabel">MCP connection</span>
        <h1>Connect {clientName ?? "an MCP client"}</h1>
        <p>
          It will act as you in the workspace you choose. It can read and change
          automations, their runs, tag mode, and model access.
        </p>
      </div>
      {organizations.isPending ? (
        <p className="authMuted">Loading workspaces…</p>
      ) : workspaces.length > 0 ? (
        <fieldset className="workspaceList oauthWorkspaceList">
          <legend className="srOnly">Workspace</legend>
          {workspaces.map((workspace) => (
            <label className="workspaceChoice" key={workspace.id}>
              <input
                checked={selectedWorkspace?.id === workspace.id}
                className="srOnly"
                disabled={isSubmitting}
                name="workspace"
                onChange={() => setSelected(workspace.id)}
                type="radio"
                value={workspace.id}
              />
              <span>{workspace.name}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <form className="authForm workspaceCreate oauthWorkspaceCreate" onSubmit={createWorkspace}>
          <label className="authField">
            <span>Create a workspace to connect</span>
            <input
              minLength={2}
              name="organizationName"
              placeholder="Acme"
              required
              type="text"
            />
          </label>
          <button
            className="button button--secondary authSubmit oauthSecondary"
            disabled={isSubmitting}
            type="submit"
          >
            Create workspace
          </button>
        </form>
      )}
      {error ? <p className="authError oauthError">{error}</p> : null}
      <div className="oauthActions">
        <button
          className="button button--primary authSubmit"
          disabled={isSubmitting || !selectedWorkspace}
          onClick={() => void decide(true)}
          type="button"
        >
          {isSubmitting ? "Please wait…" : "Allow"}
        </button>
        <button
          className="button button--secondary authSubmit oauthSecondary"
          disabled={isSubmitting}
          onClick={() => void decide(false)}
          type="button"
        >
          Cancel
        </button>
      </div>
      <p className="authTerms">
        Signed in as {email}.{" "}
        {redirectHost ? <>You will return to {redirectHost}. </> : null}
        <button
          className="oauthSwitchAccount"
          disabled={isSubmitting}
          onClick={() => void authClient.signOut()}
          type="button"
        >
          Use a different account
        </button>
      </p>
    </>
  );
}

export function OAuthAuthorizePage() {
  useDocumentTitle("Connect an MCP client");
  const session = authClient.useSession();
  const [request] = useState(() => oauthAuthorizationRequest(window.location.search));

  let content;
  if (!request) {
    content = (
      <div className="authIntro">
        <h1>Start from your MCP client</h1>
        <p>
          This link is incomplete or has expired. Connect Superlog again from
          the app you are using.
        </p>
      </div>
    );
  } else if (session.isPending) {
    content = <p className="authMuted">Loading Superlog…</p>;
  } else if (!session.data) {
    content = <SignIn allowLegacyHandoff={false} />;
  } else {
    content = (
      <Consent
        activeOrganizationId={session.data.session.activeOrganizationId ?? null}
        clientId={request.clientId}
        email={session.data.user.email}
        redirectHost={request.redirectHost}
      />
    );
  }
  return <AuthFrame>{content}</AuthFrame>;
}
