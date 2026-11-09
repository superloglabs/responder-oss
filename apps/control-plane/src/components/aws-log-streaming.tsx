import { useEffect, useState, type ReactNode } from "react";
import { defaultAwsRegion } from "../../../../packages/core/src/integrations/aws-regions";
import {
  awsLogSubscriptionStatusLabels,
  fetchAwsLogStreaming,
  saveAwsLogStreaming,
  type AwsLogStreaming,
} from "../aws-log-subscriptions-api";
import { useCellDirectory } from "../cells";
import { Alert, Badge, Button, CodeBlock, SelectField } from "../design-system";
import "./aws-log-streaming.css";

// Which regions of a connected AWS account send their error lines to
// Superlog. Superlog keeps one CloudWatch Logs subscription per region in the
// account (ADR 0015). Shows `fallback` where this installation has no log
// streaming.
export function AwsLogStreamingSettings({ integrationAccountId, fallback = null }: {
  integrationAccountId: string;
  fallback?: ReactNode;
}) {
  const cells = useCellDirectory();
  const [streaming, setStreaming] = useState<AwsLogStreaming | null>(null);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let current = true;
    fetchAwsLogStreaming(integrationAccountId)
      .then((value) => { if (current) setStreaming(value); })
      .catch((failure: unknown) => { if (current) setLoadError(failure instanceof Error ? failure.message : "Could not load log streaming."); });
    return () => { current = false; };
  }, [integrationAccountId]);

  // Refreshes while a region is starting or stopping. A failed refresh keeps
  // the state but replaces the object, so the next one is scheduled.
  const settling = streaming?.subscriptions.some((row) => row.status === "pending" || row.status === "removing") ?? false;
  useEffect(() => {
    if (!settling) return;
    const timer = window.setTimeout(() => {
      void fetchAwsLogStreaming(integrationAccountId)
        .then(setStreaming)
        .catch(() => setStreaming((current) => (current ? { ...current } : current)));
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [integrationAccountId, settling, streaming]);

  if (loadError) return <Alert tone="danger" title="Could not load log streaming">{loadError}</Alert>;
  if (!streaming) return null;
  if (!streaming.available) return <>{fallback}</>;

  const canManage = streaming.canManage;
  const saved = streaming.subscriptions.filter((row) => row.status !== "removing").map((row) => row.region);
  // With nothing saved yet, an admin is offered the region nearest the
  // workspace's cell, saved only when they start streaming.
  const suggested = defaultAwsRegion(cells?.current);
  const regions = chosen ?? (saved.length > 0 || !canManage ? saved : streaming.regions.includes(suggested) ? [suggested] : []);
  const dirty = regions.join(",") !== saved.join(",");
  const addable = streaming.regions.filter((region) => !regions.includes(region));
  const statusOf = (region: string) => streaming.subscriptions.find((row) => row.region === region);
  // Regions being removed stay listed, with any error, until they are gone.
  const stopping = streaming.subscriptions.filter((row) => row.status === "removing" && !regions.includes(row.region));

  async function save() {
    setSaving(true);
    setError("");
    try {
      const next = await saveAwsLogStreaming(integrationAccountId, regions);
      setStreaming(next);
      setChosen(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save log streaming.");
    } finally {
      setSaving(false);
    }
  }

  return <section className="awsLogStreaming" aria-labelledby={`aws-log-streaming-${integrationAccountId}`}>
    <h3 id={`aws-log-streaming-${integrationAccountId}`}>Send new errors to Superlog</h3>
    <p>
      Superlog subscribes to error lines in the CloudWatch Logs regions you choose, so each new error reaches it as it happens.
      It costs nothing beyond the CloudWatch ingestion you already pay. Remove a region to stop.
    </p>
    {streaming.filter && <p className="awsLogStreaming__filter">{streaming.filter}</p>}
    {streaming.stackUpdate && <StackUpdate update={streaming.stackUpdate} />}
    <ul className="awsLogStreaming__regions">
      {regions.map((region) => {
        const row = statusOf(region);
        const status = row && !dirty ? awsLogSubscriptionStatusLabels[row.status] : null;
        return <li key={region}>
          <code>{region}</code>
          {status ? <Badge tone={status.tone}>{status.label}</Badge> : <Badge>Not saved</Badge>}
          {row?.lastError && !dirty && <span className="awsLogStreaming__error">{row.lastError}</span>}
          {canManage && <Button size="small" variant="ghost" disabled={saving} onClick={() => setChosen(regions.filter((value) => value !== region))}>Remove</Button>}
        </li>;
      })}
      {stopping.map((row) => <li key={row.region}>
        <code>{row.region}</code>
        <Badge tone={awsLogSubscriptionStatusLabels.removing.tone}>{awsLogSubscriptionStatusLabels.removing.label}</Badge>
        {row.lastError && <span className="awsLogStreaming__error">{row.lastError}</span>}
      </li>)}
      {regions.length === 0 && stopping.length === 0 && <li className="awsLogStreaming__empty">No regions. Superlog reads CloudWatch only while it investigates.</li>}
    </ul>
    {!canManage && <p className="awsLogStreaming__filter">Workspace owners and admins choose the regions.</p>}
    {canManage && addable.length > 0 && <SelectField
      className="dsField--compact"
      label="Add a region"
      onChange={(region) => { if (region) setChosen([...regions, region]); }}
      options={[{ label: "Choose a region", value: "" }, ...addable.map((value) => ({ label: value, value }))]}
      searchable
      value=""
    />}
    {error && <p className="awsLogStreaming__error" role="alert">{error}</p>}
    {canManage && dirty && <div className="awsLogStreaming__actions">
      {chosen && <Button disabled={saving} onClick={() => setChosen(null)}>Cancel</Button>}
      <Button variant="primary" loading={saving} onClick={() => void save()}>
        {saved.length === 0 ? "Start streaming" : "Save regions"}
      </Button>
    </div>}
  </section>;
}

function StackUpdate({ update }: { update: NonNullable<AwsLogStreaming["stackUpdate"]> }) {
  return <Alert tone="warning" title="Update your Superlog stack first">
    <p>
      This account's stack was created before Superlog could manage log subscriptions. Update it once to add
      {" "}<code>ResponderLogSubscriptionRole</code>. The role can only create and remove CloudWatch Logs subscriptions;
      it reads no logs. Superlog retries on its own after the update.
    </p>
    <ol>
      <li>Open CloudFormation, select <strong>{update.stackName}</strong>, and choose <strong>Update</strong>.</li>
      <li>Choose <strong>Replace existing template</strong>{update.templateUrl ? " and paste the template URL below" : " and upload the downloaded template"}.</li>
      <li>Set <code>LogSubscriptionPrincipalArn</code> to <code>{update.logSubscriptionPrincipalArn}</code>, keep the other values, allow IAM resources, and submit.</li>
    </ol>
    {update.templateUrl && <CodeBlock code={update.templateUrl} language="text" />}
    <p>Or run this in a shell signed in to the account:</p>
    <CodeBlock code={update.command} language="bash" />
  </Alert>;
}
