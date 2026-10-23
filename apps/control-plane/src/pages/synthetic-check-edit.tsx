import { ArrowClockwiseIcon, LockSimpleIcon, LockSimpleOpenIcon, PaperPlaneTiltIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { TelemetryAlertSlackChannel } from "../../../../packages/core/src/db/telemetry-alerts";
import {
  syntheticAssertionOpsByKind,
  syntheticIntervals,
  syntheticMethods,
} from "../../../../packages/core/src/synthetics/types";
import { AppShell } from "../components/app-shell";
import { FormPageSkeleton } from "../components/screen-skeletons";
import { SyntheticRunDetails } from "../components/synthetics";
import { Button, IconButton, SelectField, Switch, TextAreaField, TextField } from "../design-system";
import {
  createSyntheticCheck,
  emptySyntheticForm,
  fetchSyntheticCheck,
  fetchSyntheticSlackChannels,
  intervalLabel,
  newSyntheticAssertion,
  syntheticForm,
  syntheticRequestBody,
  syntheticTestBody,
  testSyntheticCheck,
  updateSyntheticCheck,
  type SyntheticAssertionForm,
  type SyntheticAssertionKind,
  type SyntheticCheck,
  type SyntheticForm,
  type SyntheticHeaderForm,
  type SyntheticRunResult,
} from "../synthetics-api";
import { useDocumentTitle } from "../use-document-title";
import { useOrganizationCapabilities } from "../organization-capabilities";
import "../components/alerts.css";
import "../components/dashboards.css";
import "../components/synthetics.css";
import "./automation-create.css";

const kindOptions: Array<{ label: string; value: SyntheticAssertionKind }> = [
  { label: "Status code", value: "status_code" },
  { label: "Response time", value: "response_time" },
  { label: "Header", value: "header" },
  { label: "Body", value: "body" },
  { label: "JSON path", value: "json_path" },
  { label: "TLS certificate", value: "certificate_expiry" },
];

const opLabels: Record<SyntheticAssertionForm["op"], string> = {
  contains: "contains",
  eq: "is",
  exists: "exists",
  gt: "is above",
  lt: "is below",
  neq: "is not",
  not_contains: "does not contain",
  not_exists: "is absent",
};

function opLabel(kind: SyntheticAssertionKind, op: SyntheticAssertionForm["op"]): string {
  if (kind === "certificate_expiry") return "expires in over";
  if (kind === "response_time") return "below";
  return opLabels[op];
}

const valuePlaceholders: Record<SyntheticAssertionKind, string> = {
  body: "Text",
  certificate_expiry: "Days",
  header: "Value",
  json_path: "Value",
  response_time: "Milliseconds",
  status_code: "2xx or 200",
};

const timeouts = [5_000, 10_000, 20_000, 30_000].map((ms) => ({ label: `${ms / 1_000} seconds`, value: String(ms) }));
const intervals = syntheticIntervals.map((seconds) => ({ label: intervalLabel(seconds), value: String(seconds) }));
const retryOptions = [
  { label: "Don't retry", value: "0" },
  { label: "Retry once", value: "1" },
  { label: "Retry twice", value: "2" },
];
const failureOptions = [1, 2, 3, 5].map((count) => ({
  label: count === 1 ? "After a failed run" : `After ${count} failed runs in a row`,
  value: String(count),
}));

// Row keys that survive removing another row, so focus stays with its row.
function useRowKeys(length: number) {
  const [keys, setKeys] = useState<number[]>(() => Array.from({ length }, (_, index) => index));
  if (keys.length !== length) {
    const grown = keys.slice(0, length);
    let key = Math.max(-1, ...keys);
    while (grown.length < length) grown.push((key += 1));
    setKeys(grown);
  }
  return {
    keys,
    remove: (index: number) => setKeys((current) => current.filter((_, at) => at !== index)),
  };
}

function HeaderRows({ headers, onChange }: { headers: SyntheticHeaderForm[]; onChange: (headers: SyntheticHeaderForm[]) => void }) {
  const rows = useRowKeys(headers.length);
  const change = (index: number, update: Partial<SyntheticHeaderForm>) =>
    onChange(headers.map((header, at) => (at === index ? { ...header, ...update } : header)));
  return (
    <fieldset className="syntheticRows">
      <legend>Headers</legend>
      {headers.map((header, index) => (
        <div className="syntheticRows__row syntheticRows__row--header" key={rows.keys[index] ?? `new-${index}`}>
          <TextField
            autoComplete="off"
            label="Header name"
            maxLength={200}
            onChange={(event) => change(index, { name: event.target.value })}
            placeholder="Authorization"
            value={header.name}
          />
          <TextField
            autoComplete="off"
            label="Header value"
            maxLength={8_192}
            onChange={(event) => change(index, { value: event.target.value })}
            placeholder={header.saved ? "Saved. Type to replace" : "Value"}
            type={header.secret ? "password" : "text"}
            value={header.value}
          />
          <IconButton
            aria-label={header.secret ? "Stored as a secret" : "Store as a secret"}
            aria-pressed={header.secret}
            onClick={() => change(index, { saved: header.secret ? false : header.saved, secret: !header.secret, value: header.secret && header.saved ? "" : header.value })}
            size="small"
            title={header.secret ? "Secret: stored encrypted and never shown again" : "Store as a secret"}
            variant="ghost"
          >
            {header.secret ? <LockSimpleIcon size={14} weight="fill" /> : <LockSimpleOpenIcon size={14} />}
          </IconButton>
          <IconButton
            aria-label="Remove header"
            onClick={() => {
              rows.remove(index);
              onChange(headers.filter((_, at) => at !== index));
            }}
            size="small"
            variant="ghost"
          >
            <TrashIcon size={14} />
          </IconButton>
        </div>
      ))}
      {headers.length < 30 ? (
        <div>
          <Button onClick={() => onChange([...headers, { name: "", saved: false, secret: false, value: "" }])} size="small" variant="secondary">
            <PlusIcon size={12} />Add header
          </Button>
        </div>
      ) : null}
      <p className="syntheticRows__hint">Lock a header to store its value encrypted. It is sent only to the URL's host.</p>
    </fieldset>
  );
}

function AssertionRows({
  assertions,
  onChange,
}: {
  assertions: SyntheticAssertionForm[];
  onChange: (assertions: SyntheticAssertionForm[]) => void;
}) {
  const rows = useRowKeys(assertions.length);
  const change = (index: number, update: Partial<SyntheticAssertionForm>) =>
    onChange(assertions.map((assertion, at) => (at === index ? { ...assertion, ...update } : assertion)));
  return (
    <fieldset className="syntheticRows">
      <legend>Assertions</legend>
      {assertions.map((assertion, index) => {
        const keyed = assertion.kind === "header" || assertion.kind === "json_path";
        const needsValue = assertion.op !== "exists" && assertion.op !== "not_exists";
        return (
          <div className="syntheticRows__row syntheticRows__row--assertion" key={rows.keys[index] ?? `new-${index}`}>
            <SelectField
              label="Check"
              onChange={(kind) => change(index, newSyntheticAssertion(kind))}
              options={kindOptions}
              value={assertion.kind}
            />
            {keyed ? (
              <TextField
                className="syntheticRows__key"
                label={assertion.kind === "header" ? "Header name" : "JSON path"}
                maxLength={500}
                onChange={(event) => change(index, { key: event.target.value })}
                placeholder={assertion.kind === "header" ? "Header name, such as content-type" : "JSON path, such as $.status"}
                value={assertion.key}
              />
            ) : null}
            <SelectField
              disabled={syntheticAssertionOpsByKind[assertion.kind].length === 1}
              label="Comparison"
              onChange={(op) => change(index, { op })}
              options={syntheticAssertionOpsByKind[assertion.kind].map((op) => ({ label: opLabel(assertion.kind, op), value: op }))}
              value={assertion.op}
            />
            {needsValue ? (
              <TextField
                label="Expected value"
                maxLength={1_000}
                onChange={(event) => change(index, { value: event.target.value })}
                placeholder={valuePlaceholders[assertion.kind]}
                value={assertion.value}
              />
            ) : (
              <span aria-hidden="true" className="syntheticRows__spacer" />
            )}
            <SelectField
              label="Severity"
              onChange={(severity) => change(index, { severity })}
              options={[
                { label: "Fails", value: "critical" },
                { label: "Degrades", value: "degraded" },
              ]}
              value={assertion.severity}
            />
            <IconButton
              aria-label="Remove assertion"
              onClick={() => {
                rows.remove(index);
                onChange(assertions.filter((_, at) => at !== index));
              }}
              size="small"
              variant="ghost"
            >
              <TrashIcon size={14} />
            </IconButton>
          </div>
        );
      })}
      {assertions.length < 20 ? (
        <div>
          <Button onClick={() => onChange([...assertions, newSyntheticAssertion("status_code")])} size="small" variant="secondary">
            <PlusIcon size={12} />Add assertion
          </Button>
        </div>
      ) : null}
      <p className="syntheticRows__hint">
        A run fails when the request fails or a failing assertion does not hold. Assertions that degrade mark the run degraded without alerting.
      </p>
    </fieldset>
  );
}

function TestPanel({ checkId, form }: { checkId: string | null; form: SyntheticForm }) {
  const [state, setState] = useState<{ result: SyntheticRunResult } | { error: string } | null>(null);
  const [running, setRunning] = useState(false);

  async function run() {
    const request = syntheticTestBody(form, checkId);
    if ("error" in request) {
      setState({ error: request.error });
      return;
    }
    setRunning(true);
    try {
      setState({ result: await testSyntheticCheck(request.body) });
    } catch (cause) {
      setState({ error: cause instanceof Error ? cause.message : "Unable to test the request" });
    } finally {
      setRunning(false);
    }
  }

  return (
    <section aria-label="Test" className="alertPreview">
      <header className="dashboardPage__titleRow">
        <h2>Test</h2>
        <span className="automationCreate__spacer" />
        <Button loading={running} onClick={() => void run()} size="small" variant="secondary">
          <PaperPlaneTiltIcon size={12} />Send request
        </Button>
      </header>
      {!state ? (
        <p className="dashboardWidget__status">Send the request once to see the response and which assertions hold.</p>
      ) : "error" in state ? (
        <p className="formError" role="alert">{state.error}</p>
      ) : (
        <SyntheticRunDetails {...state.result} />
      )}
    </section>
  );
}

export function SyntheticCheckEditPage() {
  const { checkId } = useParams();
  const navigate = useNavigate();
  const telemetry = useOrganizationCapabilities().includes("telemetry");
  const [loaded, setLoaded] = useState<{ check: SyntheticCheck; checkId: string } | null>(null);
  const [edited, setEdited] = useState<{ checkId: string | undefined; form: SyntheticForm } | null>(null);
  const [failedLoad, setFailedLoad] = useState<{ checkId: string; error: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [channels, setChannels] = useState<TelemetryAlertSlackChannel[] | null>(null);
  const [refreshingChannels, setRefreshingChannels] = useState(false);
  const saved = loaded && loaded.checkId === checkId ? loaded.check : null;
  const loadError = failedLoad && failedLoad.checkId === checkId ? failedLoad.error : null;
  useDocumentTitle(saved ? `Edit ${saved.name} · Synthetic checks` : "New check · Synthetic checks");

  useEffect(() => {
    if (!checkId) return;
    let cancelled = false;
    fetchSyntheticCheck(checkId)
      .then((detail) => { if (!cancelled) setLoaded({ check: detail.check, checkId }); })
      .catch((cause: unknown) => {
        if (!cancelled) setFailedLoad({ checkId, error: cause instanceof Error ? cause.message : "Unable to load the check" });
      });
    return () => { cancelled = true; };
  }, [checkId]);

  useEffect(() => {
    let cancelled = false;
    fetchSyntheticSlackChannels()
      .then((list) => { if (!cancelled) setChannels(list); })
      .catch(() => { if (!cancelled) setChannels([]); });
    return () => { cancelled = true; };
  }, []);

  const form =
    edited && edited.checkId === checkId
      ? edited.form
      : saved
        ? syntheticForm(saved)
        : !checkId
          ? emptySyntheticForm()
          : null;
  const update = (change: Partial<SyntheticForm>) => {
    if (form) setEdited({ checkId, form: { ...form, ...change } });
  };

  async function save() {
    if (!form) return;
    const request = syntheticRequestBody(form);
    if ("error" in request) {
      setError(request.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const check = saved ? await updateSyntheticCheck(saved.id, request.body) : await createSyntheticCheck(request.body);
      navigate(`/synthetics/${check.id}`, { replace: !saved });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the check");
    } finally {
      setSaving(false);
    }
  }

  async function refreshChannels() {
    setRefreshingChannels(true);
    try {
      setChannels(await fetchSyntheticSlackChannels(true));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to refresh Slack channels");
    } finally {
      setRefreshingChannels(false);
    }
  }

  if (!form) {
    return (
      <AppShell active="synthetics" redesigned>
        {loadError ? (
          <div className="automationRuns__message" role="alert">
            <p>{loadError}</p>
          </div>
        ) : (
          <FormPageSkeleton className="alertPage syntheticEditor" label="Loading check…" />
        )}
      </AppShell>
    );
  }

  const accounts = new Set(channels?.map((channel) => channel.integrationAccountId));
  const slackOptions = [
    { label: "Don't post", value: "" },
    ...(form.slack && !channels?.some((channel) => `${channel.integrationAccountId}:${channel.channelId}` === form.slack)
      ? [{ label: "A channel that is no longer available", value: form.slack }]
      : []),
    ...(channels ?? []).map((channel) => ({
      label: `#${channel.name}${accounts.size > 1 ? ` (${channel.accountName})` : ""}`,
      value: `${channel.integrationAccountId}:${channel.channelId}`,
    })),
  ];
  const title = saved ? `Edit ${saved.name}` : "New check";

  return (
    <AppShell active="synthetics" redesigned>
      <div className="alertPage syntheticEditor">
        <header className="automationCreate__header">
          <nav aria-label="Breadcrumb" className="automationCreate__breadcrumb">
            <Link to="/synthetics">Synthetic checks</Link>
            <span aria-hidden="true">›</span>
            {saved ? (
              <>
                <Link to={`/synthetics/${saved.id}`}>{saved.name}</Link>
                <span aria-hidden="true">›</span>
                <span aria-current="page">Edit</span>
              </>
            ) : (
              <span aria-current="page">New check</span>
            )}
          </nav>
          <div className="dashboardPage__titleRow">
            <h1>{title}</h1>
            <span className="automationCreate__spacer" />
            <Link className="dsButton dsButton--ghost dsButton--small" to={saved ? `/synthetics/${saved.id}` : "/synthetics"}>Cancel</Link>
            <Button loading={saving} onClick={() => void save()} size="small" variant="primary">
              {saved ? "Save changes" : "Create check"}
            </Button>
          </div>
        </header>
        {error ? <p className="formError" role="alert">{error}</p> : null}
        <div className="alertPage__body">
          <form className="alertForm" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <TextField label="Name" maxLength={200} onChange={(event) => update({ name: event.target.value })} placeholder="Checkout API" value={form.name} />

            <section className="alertForm__section">
              <h2>Request</h2>
              <div className="syntheticForm__url">
                <SelectField
                  label="Method"
                  onChange={(method) => update({ method })}
                  options={syntheticMethods.map((method) => ({ label: method, value: method }))}
                  value={form.method}
                />
                <TextField
                  autoComplete="off"
                  inputMode="url"
                  label="URL"
                  maxLength={2_048}
                  onChange={(event) => update({ url: event.target.value })}
                  placeholder="https://api.example.com/health"
                  value={form.url}
                />
              </div>
              <HeaderRows headers={form.headers} onChange={(headers) => update({ headers })} />
              {form.method !== "GET" && form.method !== "HEAD" ? (
                <TextAreaField
                  className="syntheticForm__body"
                  label="Body"
                  maxLength={65_536}
                  onChange={(event) => update({ body: event.target.value })}
                  placeholder='{"ping": true}'
                  value={form.body}
                />
              ) : null}
              <div className="widgetEditor__row">
                <SelectField label="Timeout" onChange={(value) => update({ timeoutMs: Number(value) })} options={timeouts} value={String(form.timeoutMs)} />
              </div>
              <Switch checked={form.followRedirects} label="Follow redirects" onCheckedChange={(followRedirects) => update({ followRedirects })} />
            </section>

            <section className="alertForm__section">
              <h2>Success criteria</h2>
              <AssertionRows assertions={form.assertions} onChange={(assertions) => update({ assertions })} />
            </section>

            <section className="alertForm__section">
              <h2>Schedule</h2>
              <div className="widgetEditor__row">
                <SelectField label="Run" onChange={(value) => update({ intervalSeconds: Number(value) })} options={intervals} value={String(form.intervalSeconds)} />
                <SelectField label="When a run fails" onChange={(value) => update({ retries: Number(value) })} options={retryOptions} value={String(form.retries)} />
              </div>
              <p className="dashboardDialog__hint">Retries are made at once. Only the last attempt counts.</p>
              {telemetry ? (
                <p className="dashboardDialog__hint">
                  Each run is also sent to this workspace&apos;s metrics as synthetic_check.up, synthetic_check.duration and
                  synthetic_check.phase.duration, for dashboards and alerts.
                </p>
              ) : null}
            </section>

            <section className="alertForm__section">
              <h2>Notifications</h2>
              <div className="alertForm__slack">
                <SelectField
                  label="Slack channel"
                  onChange={(slack) => update({ slack })}
                  options={slackOptions}
                  searchable={slackOptions.length > 8}
                  value={form.slack}
                />
                <IconButton aria-label="Refresh Slack channels" disabled={refreshingChannels} onClick={() => void refreshChannels()} size="small" variant="ghost">
                  <ArrowClockwiseIcon size={14} />
                </IconButton>
              </div>
              <SelectField label="Alert" onChange={(value) => update({ failuresToAlert: Number(value) })} options={failureOptions} value={String(form.failuresToAlert)} />
              {channels && channels.length === 0 ? (
                <p className="dashboardDialog__hint">
                  Connect Slack in <Link to="/settings">Integrations</Link> to post failures. Private channels appear once the Superlog app is in them.
                </p>
              ) : (
                <p className="dashboardDialog__hint">
                  Posts when the check starts failing and replies in the thread when it recovers. Automations watching the channel start from the post.
                </p>
              )}
              <Switch checked={form.enabled} label="Run this check" onCheckedChange={(enabled) => update({ enabled })} />
            </section>
          </form>
          <TestPanel checkId={saved?.id ?? null} form={form} />
        </div>
      </div>
    </AppShell>
  );
}
