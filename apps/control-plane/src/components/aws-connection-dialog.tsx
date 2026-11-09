import { useCallback, useEffect, useState, type FormEvent } from "react";
import { defaultAwsRegion } from "../../../../packages/core/src/integrations/aws-regions";
import { useCellDirectory } from "../cells";
import { awsRegions } from "../telemetry-sources-api";

interface AwsSetup {
  accountId: string;
  cloudFormationUrl: string | null;
  streamsLogs?: boolean;
  template: string;
}

export function AwsConnectionDialog({
  connectUrl,
  open,
  onCancel,
  returnTo,
}: {
  connectUrl: string;
  open: boolean;
  onCancel: () => void;
  returnTo: string;
}) {
  const [awsAccountId, setAwsAccountId] = useState("");
  // Starts on the region nearest this workspace's cell until one is chosen.
  const cells = useCellDirectory(open);
  const [chosenRegion, setRegion] = useState<string | null>(null);
  const region = chosenRegion ?? defaultAwsRegion(cells?.current);
  const [setup, setSetup] = useState<AwsSetup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cancel = useCallback(() => {
    if (isSubmitting) return;
    setAwsAccountId("");
    setSetup(null);
    setError(null);
    onCancel();
  }, [isSubmitting, onCancel]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [cancel, open]);

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(connectUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: awsAccountId, region, returnTo }),
      });
      const body = (await response.json().catch(() => null)) as
        | (Partial<AwsSetup> & { error?: string })
        | null;
      if (
        !response.ok ||
        !body?.accountId ||
        !body.template
      ) {
        throw new Error(body?.error ?? "Unable to prepare AWS access");
      }
      setSetup(body as AwsSetup);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to prepare AWS access",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function verify() {
    if (!setup || isSubmitting) return;
    setError(null);
    setIsSubmitting(true);
    try {
      const response = await fetch(connectUrl.replace(/\/connect$/, "/verify"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          integrationAccountId: setup.accountId,
          returnTo,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string; redirectUrl?: string }
        | null;
      if (!response.ok || !body?.redirectUrl) {
        throw new Error(body?.error ?? "Unable to verify AWS access");
      }
      window.location.assign(body.redirectUrl);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to verify AWS access",
      );
      setIsSubmitting(false);
    }
  }

  function downloadTemplate() {
    if (!setup) return;
    const url = URL.createObjectURL(
      new Blob([setup.template], { type: "application/yaml" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "responder-aws-access.yaml";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  if (!open) return null;

  return (
    <div
      className="siteDialogBackdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <section
        aria-labelledby="aws-connection-title"
        aria-modal="true"
        className="siteDialog siteDialog--credentials"
        role="dialog"
      >
        <header className="siteDialog__header">
          <span>Connect AWS</span>
          <h2 id="aws-connection-title">
            {setup ? "Create the investigation role" : "Choose an AWS account"}
          </h2>
          <p>
            Responder receives temporary, read-only sessions. No access keys are
            created or stored.
          </p>
        </header>

        {!setup ? (
          <form className="siteDialog__form" onSubmit={prepare}>
            <label className="siteDialog__field">
              <span>AWS account ID</span>
              <input
                autoFocus
                disabled={isSubmitting}
                inputMode="numeric"
                maxLength={12}
                minLength={12}
                onChange={(event) =>
                  setAwsAccountId(event.target.value.replace(/\D/g, ""))
                }
                placeholder="123456789012"
                required
                value={awsAccountId}
              />
            </label>
            <label className="siteDialog__field">
              <span>Region</span>
              <select
                disabled={isSubmitting}
                onChange={(event) => setRegion(event.target.value)}
                value={region}
              >
                {awsRegions.map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </select>
            </label>
            <p className="siteDialog__oauthNote">
              The role uses AWS-managed AIOpsAssistantPolicy and can inspect all
              regions in this account. It cannot change resources. The stack
              opens in this region. If the workspace receives telemetry, the
              stack also streams this region's CloudWatch logs to Superlog;
              Firehose and CloudWatch Logs delivery are billed to your AWS
              account. AWS allows one account-wide log subscription per
              region, so the stack fails if this region already has one.
            </p>
            {error ? <p className="siteDialog__error" role="alert">{error}</p> : null}
            <footer className="siteDialog__footer">
              <button className="button button--secondary button--small" onClick={cancel} type="button">
                Cancel
              </button>
              <button
                className="button button--primary button--small"
                disabled={isSubmitting || awsAccountId.length !== 12}
                type="submit"
              >
                {isSubmitting ? "Preparing…" : "Continue"}
              </button>
            </footer>
          </form>
        ) : (
          <div className="siteDialog__form">
            <ol className="siteDialog__instructions">
              <li>
                Open AWS CloudFormation and review the role and policy
                {setup.streamsLogs ? `, and the stream of ${region} CloudWatch logs to Superlog` : ""}.
              </li>
              <li>Create the stack and wait until its status is CREATE_COMPLETE.</li>
              <li>Return here and verify the connection.</li>
            </ol>
            {!setup.cloudFormationUrl ? (
              <p className="siteDialog__oauthNote">
                Download the template and upload it on the CloudFormation
                <strong> Create stack</strong> page.
              </p>
            ) : null}
            {error ? <p className="siteDialog__error" role="alert">{error}</p> : null}
            <footer className="siteDialog__footer siteDialog__footer--wrap">
              <button className="button button--secondary button--small" onClick={downloadTemplate} type="button">
                Download template
              </button>
              {setup.cloudFormationUrl ? (
                <a
                  className="button button--secondary button--small"
                  href={setup.cloudFormationUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open CloudFormation
                </a>
              ) : null}
              <button
                className="button button--primary button--small"
                disabled={isSubmitting}
                onClick={() => void verify()}
                type="button"
              >
                {isSubmitting ? "Verifying…" : "Verify connection"}
              </button>
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}
