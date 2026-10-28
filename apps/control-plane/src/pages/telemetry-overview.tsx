import { NavigationIcon } from "../components/navigation-icon";
import {
  CaretDownIcon,
  CheckCircleIcon,
  CoinsIcon,
  CubeIcon,
  SparkleIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { fetchSuggestion, fetchSuggestions } from "../agents-api";
import { AppShell } from "../components/app-shell";
import { TelemetryOverviewSkeleton } from "../components/screen-skeletons";
import { CopyPromptButton } from "../components/copy-prompt-button";
import { HairlineComputer } from "../components/hairline-computer";
import { SendTelemetryLink, TelemetryGate } from "../components/telemetry";
import { SegmentedControl, SelectField } from "../design-system";
import {
  fetchTelemetryOverview,
  fetchTelemetryOverviewDetails,
  type OverviewService,
  type TelemetryOverview,
  type TelemetryRange,
} from "../telemetry-api";
import { useDocumentTitle } from "../use-document-title";
import { useIngestAvailable } from "../use-ingest-available";
import { useTelemetryAvailable } from "../use-telemetry-available";
import { useTelemetryQuery } from "../use-telemetry-query";
import {
  aiCostCallout,
  formatCount,
  logPills,
  rangeLabel,
  serviceProblems,
  suggestionPrompt,
  tracePills,
  withOverviewDetails,
  type AiCostCallout,
  type OverviewProblem,
  type PillLevel,
} from "./telemetry-overview-presentation";
import "./telemetry-overview.css";

const ranges: Array<{ label: string; value: TelemetryRange }> = [
  { label: "Last hour", value: "1h" },
  { label: "Last 6 hours", value: "6h" },
  { label: "Last 24 hours", value: "24h" },
  { label: "Last 7 days", value: "7d" },
];
// Healthy services listed before the rest fold away.
const healthyShown = 3;

function isRange(value: string | null): value is TelemetryRange {
  return ranges.some((range) => range.value === value);
}

function Pills({ label, levels, tone }: { label: string; levels: PillLevel[]; tone: "logs" | "traces" }) {
  return (
    <div aria-label={label} className={`telOverviewPills telOverviewPills--${tone}`} role="img">
      {levels.map((level, index) => (
        <span className={`telOverviewPills__pill telOverviewPills__pill--${level}`} key={index} />
      ))}
    </div>
  );
}

function Stat({ dot, label, unit, value }: { dot?: "error" | "warning"; label: string; unit?: string; value: string }) {
  return (
    <div className="telOverviewStat">
      <span className="telOverviewStat__label">
        {dot ? <span className={`telOverviewStat__dot telOverviewStat__dot--${dot}`} /> : null}
        {label}
      </span>
      <span className="telOverviewStat__value">
        {value}
        {unit ? <small>{unit}</small> : null}
      </span>
    </div>
  );
}

function SignalPanels({ range, service }: { range: TelemetryRange; service: OverviewService }) {
  const window = rangeLabel(range);
  return (
    <div className="telOverviewSignals">
      <section className="telOverviewSignal">
        <h3>Logs</h3>
        {service.logs ? (
          <>
            <div className="telOverviewSignal__stats">
              <Stat label="All" value={formatCount(service.logs.total)} />
              <Stat dot="error" label="Errors" value={formatCount(service.logs.errors)} />
              <Stat dot="warning" label="Warnings" value={formatCount(service.logs.warnings)} />
            </div>
            <Pills label={`Logs over ${window}, with error and warning spikes`} levels={logPills(service.logs.buckets)} tone="logs" />
          </>
        ) : (
          <MissingSignal label="Not sending logs" window={window} />
        )}
      </section>
      <section className="telOverviewSignal">
        <h3>Traces</h3>
        {service.traces ? (
          <>
            <div className="telOverviewSignal__stats">
              <Stat label="Spans" value={formatCount(service.traces.total)} />
              <Stat dot="error" label="Errors" value={formatCount(service.traces.errors)} />
              <Stat
                dot="warning"
                label="Slow"
                unit="over 1s"
                value={service.traces.slow === null ? "–" : formatCount(service.traces.slow)}
              />
            </div>
            <Pills label={`Traces over ${window}, with error and slow spikes`} levels={tracePills(service.traces.buckets)} tone="traces" />
          </>
        ) : (
          <MissingSignal label="Not sending traces" window={window} />
        )}
      </section>
    </div>
  );
}

function MissingSignal({ label, window }: { label: string; window: string }) {
  return (
    <>
      <div className="telOverviewSignal__stats">
        <div className="telOverviewStat">
          <span className="telOverviewStat__label">All</span>
          <span className="telOverviewStat__value telOverviewStat__value--missing">
            0<small>{label}</small>
          </span>
        </div>
      </div>
      <Pills label={`Nothing received over ${window}`} levels={Array<PillLevel>(48).fill("empty")} tone="logs" />
    </>
  );
}

function ProblemRow({ problem }: { problem: OverviewProblem }) {
  return (
    <li className="telOverviewRow">
      <span className="telOverviewRow__icon">
        {problem.severity === "error" ? (
          <XCircleIcon aria-label="Problem" className="telOverviewRow__icon--error" size={16} />
        ) : (
          <WarningIcon aria-label="Warning" className="telOverviewRow__icon--warning" size={16} />
        )}
      </span>
      <span className="telOverviewRow__text">
        <strong>{problem.title}</strong>
        <span>{problem.detail}</span>
      </span>
      <CopyPromptButton prompt={() => problem.prompt} />
    </li>
  );
}

function Tray({ children, label, status }: { children: ReactNode; label: ReactNode; status?: ReactNode }) {
  return (
    <section className="telOverviewTray">
      <header className="telOverviewTray__label">
        <span className="telOverviewTray__name">{label}</span>
        {status ? <span className="telOverviewTray__status">{status}</span> : null}
      </header>
      <div className="telOverviewTray__card">{children}</div>
    </section>
  );
}

function ServiceTray({ range, service }: { range: TelemetryRange; service: OverviewService }) {
  const problems = serviceProblems(service, range);
  const worst = problems.some((problem) => problem.severity === "error") ? "error" : problems.length ? "warning" : "ok";
  return (
    <Tray
      label={
        <>
          <CubeIcon aria-hidden="true" size={14} />
          {service.name || "unknown_service"}
        </>
      }
      status={
        <>
          <span className={`telOverviewDot telOverviewDot--${worst}`} />
          {problems.length === 0 ? "No problems" : problems.length === 1 ? "1 problem" : `${problems.length} problems`}
        </>
      }
    >
      <SignalPanels range={range} service={service} />
      <ul className="telOverviewRows">
        {problems.length ? (
          problems.map((problem) => <ProblemRow key={problem.id} problem={problem} />)
        ) : (
          <li className="telOverviewRow telOverviewRow--quiet">
            <span className="telOverviewRow__icon">
              <CheckCircleIcon aria-hidden="true" className="telOverviewRow__icon--ok" size={16} />
            </span>
            <span className="telOverviewRow__text">
              <span>No problems in {rangeLabel(range)}.</span>
            </span>
          </li>
        )}
      </ul>
    </Tray>
  );
}

function AiCostTray({ callout }: { callout: AiCostCallout }) {
  const most = Math.max(1, ...callout.models.map((model) => model.calls));
  return (
    <Tray
      label={
        <>
          <CoinsIcon aria-hidden="true" size={14} />
          AI cost
        </>
      }
      status={
        <>
          <span className="telOverviewDot" />
          Not set up
        </>
      }
    >
      <div className="telOverviewAi">
        <div className="telOverviewAi__pitch">
          <h3>See what your AI calls cost</h3>
          <p>{callout.detail}</p>
          <ul className="telOverviewAi__attributes">
            {callout.attributes.map((attribute) => (
              <li key={attribute.key}>
                {attribute.state === "found" ? (
                  <CheckCircleIcon aria-hidden="true" className="telOverviewRow__icon--ok" size={14} />
                ) : (
                  <span aria-hidden="true" className={`telOverviewAi__pending telOverviewAi__pending--${attribute.state}`} />
                )}
                <code>{attribute.key}</code>
                <span className={attribute.state === "found" ? undefined : "telOverviewAi__missing"}>{attribute.note}</span>
              </li>
            ))}
          </ul>
          <div className="telOverviewAi__action">
            <CopyPromptButton prompt={() => callout.prompt} />
            <span>About 5 minutes with your coding agent</span>
          </div>
        </div>
        {callout.models.length ? (
          <div className="telOverviewAi__preview">
            <header>
              <strong>Spend by model</strong>
              <span>preview</span>
            </header>
            <ul>
              {callout.models.map((model) => (
                <li key={model.model}>
                  <span className="telOverviewAi__model">
                    <code>{model.model}</code>
                    <span>$ — · {formatCount(model.calls)} calls</span>
                  </span>
                  <span className="telOverviewAi__bar" style={{ width: `${Math.max(8, (model.calls / most) * 100)}%` }} />
                </li>
              ))}
            </ul>
            <p>Models detected from your spans. Cost fills in once token counts arrive.</p>
          </div>
        ) : null}
      </div>
    </Tray>
  );
}

function Suggestions() {
  const suggestions = useTelemetryQuery("open", () => fetchSuggestions(undefined, { status: "open" }));
  const open = suggestions.data?.suggestions.slice(0, 5) ?? [];
  if (open.length === 0) return null;
  return (
    <>
      <div className="telOverviewSection">
        <h2>Suggestions</h2>
        <span>Observability improvements found by your scans</span>
        <Link className="telOverviewSection__link" to="/suggestions">View all</Link>
      </div>
      <Tray
        label={
          <>
            <SparkleIcon aria-hidden="true" size={14} />
            Open suggestions
          </>
        }
        status={open.length === 1 ? "1 suggestion" : `${open.length} suggestions`}
      >
        <ul className="telOverviewRows telOverviewRows--flush">
          {open.map((suggestion) => (
            <li className="telOverviewRow" key={suggestion.id}>
              <span className="telOverviewRow__icon">
                <SparkleIcon aria-hidden="true" className="telOverviewRow__icon--suggestion" size={16} weight="fill" />
              </span>
              <Link className="telOverviewRow__text" to={`/suggestions/${suggestion.id}`}>
                <strong>{suggestion.title}</strong>
                <span>{suggestion.subtitle}</span>
              </Link>
              <CopyPromptButton
                prompt={() => fetchSuggestion(suggestion.id).then((detail) => suggestionPrompt(detail.suggestion))}
              />
            </li>
          ))}
        </ul>
      </Tray>
    </>
  );
}

function EmptyOverview() {
  const ingest = useIngestAvailable();
  return (
    <div className="telOverviewEmpty">
      <HairlineComputer />
      <h2>No telemetry yet</h2>
      <p>Send logs and traces from your services. Each service shows up here with what it sends and what to fix.</p>
      {ingest ? (
        <div className="telOverviewEmpty__actions">
          <Link className="dsButton dsButton--primary dsButton--medium" to="/telemetry/setup/opentelemetry">Set up OpenTelemetry</Link>
          <Link className="dsButton dsButton--secondary dsButton--medium" to="/telemetry/setup">Other ways to connect</Link>
        </div>
      ) : null}
    </div>
  );
}

// An empty overview shows its own setup links instead of the services.
function isEmpty(overview: TelemetryOverview, range: TelemetryRange): boolean {
  return overview.services.length === 0 && !aiCostCallout(overview.ai, range);
}

function OverviewBody({ overview, range }: { overview: TelemetryOverview; range: TelemetryRange }) {
  const [filter, setFilter] = useState<"all" | "problems">("all");
  const [showHealthy, setShowHealthy] = useState(false);
  const callout = aiCostCallout(overview.ai, range);
  if (isEmpty(overview, range)) return <EmptyOverview />;

  const rated = overview.services.map((service) => {
    const problems = serviceProblems(service, range);
    return { problems, service, weight: problems.some((problem) => problem.severity === "error") ? 2 : problems.length ? 1 : 0 };
  });
  const withProblems = rated.filter((entry) => entry.weight > 0).sort((a, b) => b.weight - a.weight);
  const healthy = rated.filter((entry) => entry.weight === 0);
  const problemCount = rated.reduce((count, entry) => count + entry.problems.length, 0);
  const shownHealthy = filter === "problems" ? [] : showHealthy ? healthy : healthy.slice(0, healthyShown);
  const folded = filter === "problems" ? [] : healthy.slice(shownHealthy.length);

  return (
    <>
      {callout ? <AiCostTray callout={callout} /> : null}
      <div className="telOverviewSection">
        <h2>Services</h2>
        <span>
          {overview.services.length} detected · {problemCount === 1 ? "1 problem" : `${problemCount} problems`}
        </span>
        <SegmentedControl
          aria-label="Services shown"
          compact
          onChange={setFilter}
          options={[
            { label: `All ${overview.services.length}`, value: "all" },
            { label: `With problems ${withProblems.length}`, value: "problems" },
          ]}
          value={filter}
        />
      </div>
      {[...withProblems, ...shownHealthy].map(({ service }) => (
        <ServiceTray key={service.name} range={range} service={service} />
      ))}
      {filter === "problems" && withProblems.length === 0 ? <p className="telOverviewNote">No service has a problem in {rangeLabel(range)}.</p> : null}
      {folded.length ? (
        <button className="telOverviewMore" onClick={() => setShowHealthy(true)} type="button">
          <span className="telOverviewDot telOverviewDot--ok" />
          <span>{folded.length === 1 ? "1 more service with no problems" : `${folded.length} more services with no problems`}</span>
          <code>{folded.slice(0, 4).map((entry) => entry.service.name).join(" · ")}{folded.length > 4 ? " …" : ""}</code>
          <span className="telOverviewMore__action">
            Show
            <CaretDownIcon aria-hidden="true" size={12} />
          </span>
        </button>
      ) : null}
      <Suggestions />
    </>
  );
}

export function TelemetryOverviewPage() {
  useDocumentTitle("Overview");
  const telemetry = useTelemetryAvailable();
  const [params, setParams] = useSearchParams();
  const requested = params.get("range");
  const range: TelemetryRange = isRange(requested) ? requested : "24h";
  const overview = useTelemetryQuery(telemetry.available ? range : null, () => fetchTelemetryOverview(range));
  // Slow requests, exception details, trace links and model calls take longer
  // to count, so they fill in after the volumes.
  const details = useTelemetryQuery(telemetry.available ? range : null, () => fetchTelemetryOverviewDetails(range));

  return (
    <AppShell active="telemetry-overview" redesigned wide>
      <div className="explorer telemetryOverview">
        <header className="workspaceHeading telemetryOverview__heading">
          <div>
            <h1><NavigationIcon section="telemetry-overview" />Overview</h1>
            <p>What Superlog receives from your services, and what to fix.</p>
          </div>
          {telemetry.available ? (
            <div className="workspaceHeading__actions explorerTime">
              <SelectField
                className="dsField--compact telemetryOverview__range"
                label="Time range"
                onChange={(value) => setParams(value === "24h" ? {} : { range: value }, { replace: true })}
                options={ranges}
                value={range}
              />
              {overview.data && !isEmpty(overview.data.overview, range) ? <SendTelemetryLink variant="secondary" /> : null}
            </div>
          ) : null}
        </header>
        <TelemetryGate signal="Telemetry" skeleton={<TelemetryOverviewSkeleton />} state={telemetry}>
          {overview.error ? (
            <div className="automationRuns__message" role="alert">
              <p>{overview.error}</p>
              <button onClick={overview.retry} type="button">Retry</button>
            </div>
          ) : overview.data ? (
            <OverviewBody
              overview={details.data ? withOverviewDetails(overview.data.overview, details.data.details) : overview.data.overview}
              range={range}
            />
          ) : (
            <TelemetryOverviewSkeleton />
          )}
        </TelemetryGate>
      </div>
    </AppShell>
  );
}
