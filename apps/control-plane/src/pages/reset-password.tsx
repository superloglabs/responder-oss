import { type FormEvent, useState } from "react";
import { authClient } from "../auth-client";
import { authErrorCode } from "../auth-error-code";
import { AuthFrame } from "../components/auth-gate";
import { useDocumentTitle } from "../use-document-title";

// The reset email links to Better Auth, which checks the token and returns
// here with either `token` or `error=INVALID_TOKEN`.
export function ResetPasswordPage() {
  useDocumentTitle("Reset password");
  const [token] = useState(() =>
    new URLSearchParams(window.location.search).get("token"),
  );
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setError(null);
    setIsSubmitting(true);
    const newPassword = String(
      new FormData(event.currentTarget).get("password") ?? "",
    );
    const result = await authClient.resetPassword({ newPassword, token });
    setIsSubmitting(false);
    if (result.error) {
      console.error(
        JSON.stringify({
          event: "password_reset_failed",
          errorCode: authErrorCode(result.error),
        }),
      );
      setError(
        result.error.code === "INVALID_TOKEN"
          ? "This reset link is invalid or has expired. Request a new one."
          : (result.error.message ?? "Could not reset the password"),
      );
      return;
    }
    console.info(JSON.stringify({ event: "password_reset_success" }));
    setIsDone(true);
  }

  if (isDone) {
    return (
      <AuthFrame>
        <div className="authIntro">
          <h1>Password updated</h1>
          <p>Sign in with your new password.</p>
        </div>
        <a className="button button--primary authSubmit" href="/app">
          Sign in
        </a>
      </AuthFrame>
    );
  }

  if (!token) {
    return (
      <AuthFrame>
        <div className="authIntro">
          <h1>Link expired</h1>
          <p>This reset link is invalid or has expired. Request a new one.</p>
        </div>
        <a className="button button--primary authSubmit" href="/app">
          Back to sign in
        </a>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <div className="authIntro">
        <h1>Choose a new password</h1>
        <p>You’ll be signed out of other devices.</p>
      </div>
      <form className="authForm" onSubmit={submit}>
        <div className="authField">
          <label htmlFor="reset-password">New password</label>
          <span className="authPassword">
            <input
              autoComplete="new-password"
              autoFocus
              id="reset-password"
              maxLength={128}
              minLength={8}
              name="password"
              placeholder="At least 8 characters"
              required
              type={showPassword ? "text" : "password"}
            />
            <button
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((value) => !value)}
              type="button"
            >
              <svg aria-hidden="true" fill="none" viewBox="0 0 18 18">
                <path
                  d="M1.5 9s2.5-5 7.5-5 7.5 5 7.5 5-2.5 5-7.5 5S1.5 9 1.5 9Z"
                  stroke="currentColor"
                />
                <circle cx="9" cy="9" r="2" stroke="currentColor" />
                {showPassword ? (
                  <path d="m2 2 14 14" stroke="currentColor" />
                ) : null}
              </svg>
            </button>
          </span>
        </div>
        {error ? <p className="authError">{error}</p> : null}
        <button
          className="button button--primary authSubmit"
          disabled={isSubmitting}
          type="submit"
        >
          {isSubmitting ? "Please wait…" : "Update password"}
        </button>
      </form>
    </AuthFrame>
  );
}
