import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { authErrorCode } from "../auth-error-code";
import { authClient } from "../auth-client";
import { resetBrowserAnalytics } from "../browser-analytics";
import {
  socialAuthErrorMessage,
  socialAuthUrls,
} from "../social-auth-url";
import { trackXSignupPixel } from "../x-pixel";
import { workspaceSlug } from "./workspace";
import { ImpersonationBanner } from "./impersonation-banner";
import { ProviderGlyph } from "./icons";

interface AuthGateProps {
  children: ReactNode;
}

function AuthFrame({ children }: AuthGateProps) {
  return (
    <main className="authPage">
      <section className="authCard">
        <div className="authBrand">
          <img alt="Superlog" draggable={false} src="/superlog-wordmark.svg" />
          <span>Responder</span>
        </div>
        {children}
      </section>
    </main>
  );
}

function SignIn() {
  const [isCreatingAccount, setIsCreatingAccount] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [socialProvider, setSocialProvider] = useState<"github" | "google" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(() =>
    socialAuthErrorMessage(window.location.search),
  );

  async function socialSignIn(provider: "github" | "google") {
    setError(null);
    setSocialProvider(provider);
    console.info(
      JSON.stringify({
        event: "social_sign_in_started",
        provider,
      }),
    );
    // First-time social signups land with this marker so the X signup pixel
    // fires exactly once, in AuthGate. Stale OAuth parameters are removed so
    // retries do not accumulate duplicate errors in the return URL.
    const returnUrls = socialAuthUrls(window.location.href);
    const result = await authClient.signIn.social({
      provider,
      ...returnUrls,
    });
    if (result.error || !result.data) {
      console.error(
        JSON.stringify({
          event: "social_sign_in_failed",
          provider,
          errorCode: authErrorCode(result.error, "missing_data"),
        }),
      );
      setSocialProvider(null);
      setError(
        result.error?.message ??
          `${provider === "google" ? "Google" : "GitHub"} sign in failed`,
      );
      return;
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    const result = isCreatingAccount
      ? await authClient.signUp.email({
          email,
          name: String(data.get("name") ?? ""),
          password,
        })
      : await authClient.signIn.email({ email, password });

    setIsSubmitting(false);
    if (result.error) {
      console.error(
        JSON.stringify({
          event: isCreatingAccount
            ? "email_sign_up_failed"
            : "email_sign_in_failed",
          errorCode: authErrorCode(result.error),
        }),
      );
      setError(result.error.message ?? "Authentication failed");
      return;
    }
    console.info(
      JSON.stringify({
        event: isCreatingAccount
          ? "email_sign_up_success"
          : "email_sign_in_success",
      }),
    );
    if (isCreatingAccount) {
      trackXSignupPixel(result.data.user.id);
    }
  }

  return (
    <>
      <div className="authIntro">
        <h1>{isCreatingAccount ? "Create your account" : "Welcome back"}</h1>
        <p>
          {isCreatingAccount
            ? "Start a workspace for your incident response agents."
            : "Sign in to manage your agents and investigations."}
        </p>
      </div>
      <div className="socialAuth">
        <button
          className="socialAuth__button"
          disabled={socialProvider !== null || isSubmitting}
          onClick={() => void socialSignIn("google")}
          type="button"
        >
          <ProviderGlyph decorative label="Google" text="GO" />
          {socialProvider === "google" ? "Opening Google…" : "Continue with Google"}
        </button>
        <button
          className="socialAuth__button"
          disabled={socialProvider !== null || isSubmitting}
          onClick={() => void socialSignIn("github")}
          type="button"
        >
          <ProviderGlyph decorative label="GitHub" text="GH" />
          {socialProvider === "github" ? "Opening GitHub…" : "Continue with GitHub"}
        </button>
      </div>
      <div className="authDivider">
        <span>or continue with email</span>
      </div>
      <form className="authForm" onSubmit={submit}>
        {isCreatingAccount ? (
          <label className="authField">
            <span>Name</span>
            <input
              autoComplete="name"
              minLength={2}
              name="name"
              placeholder="Ada Lovelace"
              required
              type="text"
            />
          </label>
        ) : null}
        <label className="authField">
          <span>Email</span>
          <input
            autoComplete="email"
            name="email"
            placeholder="you@company.com"
            required
            type="email"
          />
        </label>
        <label className="authField">
          <span>Password</span>
          <input
            autoComplete={isCreatingAccount ? "new-password" : "current-password"}
            minLength={8}
            name="password"
            placeholder="At least 8 characters"
            required
            type="password"
          />
        </label>
        {error ? <p className="authError">{error}</p> : null}
        <button
          className="button button--primary authSubmit"
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting
            ? "Please wait…"
            : isCreatingAccount
              ? "Create account"
              : "Sign in"}
        </button>
      </form>
      <button
        className="authSwitch"
        onClick={() => {
          setError(null);
          setIsCreatingAccount((value) => !value);
        }}
        type="button"
      >
        {isCreatingAccount
          ? "Already have an account? Sign in"
          : "New to Responder? Create an account"}
      </button>
    </>
  );
}

interface WorkspaceSetupProps {
  onReady: () => Promise<void>;
}

function WorkspaceSetup({ onReady }: WorkspaceSetupProps) {
  const organizations = authClient.useListOrganizations();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasOrganizations = (organizations.data?.length ?? 0) > 0;

  async function activate(organizationId: string, redirectTo?: string) {
    setError(null);
    setIsSubmitting(true);
    const result = await authClient.organization.setActive({ organizationId });
    setIsSubmitting(false);
    if (result.error) {
      console.error(
        JSON.stringify({
          event: "workspace_activation_failed",
          organizationId,
          errorCode: authErrorCode(result.error),
        }),
      );
      setError(result.error.message ?? "Could not open that workspace");
      return;
    }
    console.info(
      JSON.stringify({
        event: "workspace_activation_success",
        organizationId,
      }),
    );
    await onReady();
    if (redirectTo) window.location.replace(redirectTo);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const data = new FormData(event.currentTarget);
    const name = String(data.get("organizationName") ?? "").trim();
    const slug = workspaceSlug(name);
    if (!slug) {
      setIsSubmitting(false);
      setError("Use at least one letter or number in the workspace name");
      return;
    }
    const result = await authClient.organization.create({ name, slug });

    if (result.error || !result.data) {
      console.error(
        JSON.stringify({
          event: "workspace_creation_failed",
          errorCode: authErrorCode(result.error, "missing_data"),
        }),
      );
      setIsSubmitting(false);
      setError(result.error?.message ?? "Could not create the workspace");
      return;
    }

    console.info(
      JSON.stringify({
        event: "workspace_creation_success",
        organizationId: result.data.id,
      }),
    );
    await activate(result.data.id, "/agents/new");
  }

  return (
    <>
      <div className="authIntro">
        <h1>
          {organizations.isPending || hasOrganizations
            ? "Choose a workspace"
            : "Create a workspace"}
        </h1>
        <p>Your agents and integrations are isolated inside a workspace.</p>
      </div>
      {organizations.isPending ? (
        <p className="authMuted">Loading workspaces…</p>
      ) : hasOrganizations ? (
        <div className="workspaceList">
          {organizations.data?.map((organization) => (
            <button
              className="workspaceChoice"
              disabled={isSubmitting}
              key={organization.id}
              onClick={() => void activate(organization.id)}
              type="button"
            >
              <span>{organization.name}</span>
            </button>
          ))}
        </div>
      ) : null}
      <form className="authForm workspaceCreate" onSubmit={create}>
        <label className="authField">
          <span>New workspace</span>
          <input
            minLength={2}
            name="organizationName"
            placeholder="Acme"
            required
            type="text"
          />
        </label>
        {error ? <p className="authError">{error}</p> : null}
        <button
          className="button button--primary authSubmit"
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting ? "Please wait…" : "Create workspace"}
        </button>
      </form>
    </>
  );
}

function InvitationGate({
  invitationId,
  onReady,
}: {
  invitationId: string;
  onReady: () => Promise<void>;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    const result = await authClient.signOut();
    if (result.error) {
      console.error(
        JSON.stringify({
          event: "sign_out_failed",
          source: "invitation_gate",
          invitationId,
          errorCode: authErrorCode(result.error),
        }),
      );
      setError("Could not sign out. Please try again.");
      return;
    }
    console.info(
      JSON.stringify({
        event: "sign_out_success",
        source: "invitation_gate",
        invitationId,
      }),
    );
    await resetBrowserAnalytics();
    window.location.assign("/");
  }

  async function accept() {
    setError(null);
    setIsSubmitting(true);
    const result = await authClient.organization.acceptInvitation({
      invitationId,
    });
    if (result.error || !result.data) {
      console.error(
        JSON.stringify({
          event: "invitation_acceptance_failed",
          invitationId,
          errorCode: authErrorCode(result.error, "missing_data"),
        }),
      );
      setIsSubmitting(false);
      setError(
        result.error?.message ??
          "This invitation is invalid, expired, or belongs to another account.",
      );
      return;
    }

    console.info(
      JSON.stringify({
        event: "invitation_acceptance_success",
        invitationId,
        organizationId: result.data.member.organizationId,
      }),
    );
    const activeResult = await authClient.organization.setActive({
      organizationId: result.data.member.organizationId,
    });
    if (activeResult.error) {
      console.error(
        JSON.stringify({
          event: "invitation_workspace_activation_failed",
          organizationId: result.data.member.organizationId,
          errorCode: authErrorCode(activeResult.error),
        }),
      );
      setIsSubmitting(false);
      setError(activeResult.error.message ?? "Could not open the workspace");
      return;
    }
    console.info(
      JSON.stringify({
        event: "invitation_workspace_activation_success",
        organizationId: result.data.member.organizationId,
      }),
    );
    await onReady();
    window.location.replace("/agents");
  }

  return (
    <>
      <div className="authIntro">
        <h1>Join this workspace</h1>
        <p>
          Accept the invitation to access its agents, integrations, and
          investigations.
        </p>
      </div>
      {error ? <p className="authError invitationError">{error}</p> : null}
      <button
        className="button button--primary authSubmit"
        disabled={isSubmitting}
        onClick={() => void accept()}
        type="button"
      >
        {isSubmitting ? "Joining workspace…" : "Accept invitation"}
      </button>
      <button
        className="authSwitch"
        disabled={isSubmitting}
        onClick={() => void signOut()}
        type="button"
      >
        Sign in with a different account
      </button>
    </>
  );
}

export function AuthGate({ children }: AuthGateProps) {
  const session = authClient.useSession();
  const invitationMatch = window.location.pathname.match(
    /^\/invite\/([0-9a-f-]+)$/i,
  );

  const signedInUserId = session.data?.user.id;
  useEffect(() => {
    if (!signedInUserId) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("signed_up") !== "1") return;
    url.searchParams.delete("signed_up");
    window.history.replaceState(window.history.state, "", url);
    trackXSignupPixel(signedInUserId);
  }, [signedInUserId]);

  if (session.isPending) {
    return (
      <AuthFrame>
        <p className="authMuted">Loading Responder…</p>
      </AuthFrame>
    );
  }

  if (session.error) {
    return (
      <AuthFrame>
        <div className="authIntro">
          <h1>Authentication is unavailable</h1>
          <p>
            Check the local database and Better Auth environment variables, then
            try again.
          </p>
        </div>
        <button
          className="button button--secondary authSubmit"
          onClick={() => void session.refetch()}
          type="button"
        >
          Try again
        </button>
      </AuthFrame>
    );
  }

  if (!session.data) {
    return (
      <AuthFrame>
        <SignIn />
      </AuthFrame>
    );
  }

  if (invitationMatch?.[1]) {
    return (
      <>
        <ImpersonationBanner />
        <AuthFrame>
          <InvitationGate
            invitationId={invitationMatch[1]}
            onReady={session.refetch}
          />
        </AuthFrame>
      </>
    );
  }

  if (!session.data.session.activeOrganizationId) {
    return (
      <>
        <ImpersonationBanner />
        <AuthFrame>
          <WorkspaceSetup onReady={session.refetch} />
        </AuthFrame>
      </>
    );
  }

  return (
    <>
      <ImpersonationBanner />
      {children}
    </>
  );
}
