import { CheckCircleIcon, WarningCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import { describeSyntheticAssertion } from "../../../../packages/core/src/synthetics/assertions";
import type { SyntheticAssertionResult, SyntheticResponse } from "../../../../packages/core/src/synthetics/types";
import { Badge } from "../design-system";
import {
  syntheticPhases,
  syntheticStatusLabels,
  syntheticStatusTones,
  type SyntheticRunStatus,
  type SyntheticTimings,
  type UptimeSegment,
} from "../synthetics-api";
import { formatDuration } from "../telemetry-api";
import "./synthetics.css";
import "./timeseries-chart.css";

export function SyntheticStatusBadge({ status }: { status: SyntheticRunStatus }) {
  return <Badge tone={syntheticStatusTones[status]}>{syntheticStatusLabels[status]}</Badge>;
}

// Runs or buckets as a strip of coloured segments, oldest first.
export function UptimeStrip({
  label,
  segments,
  small = false,
  title,
}: {
  label: string;
  segments: Array<Pick<UptimeSegment, "status">>;
  small?: boolean;
  title?: (index: number) => string;
}) {
  return (
    <div aria-label={label} className={small ? "uptimeStrip uptimeStrip--small" : "uptimeStrip"} role="img">
      {segments.map((segment, index) => (
        <span
          className={`uptimeStrip__segment uptimeStrip__segment--${segment.status}`}
          // Segments do not move or reorder, so the index identifies them.
          key={index}
          title={title?.(index)}
        />
      ))}
    </div>
  );
}

// A request's phases as one bar with a legend.
export function SyntheticPhaseBar({ timings }: { timings: SyntheticTimings }) {
  const total = syntheticPhases.reduce((sum, [, field]) => sum + timings[field], 0);
  return (
    <div className="syntheticPhases">
      <div aria-hidden="true" className="syntheticPhases__bar">
        {syntheticPhases.map(([name, field], index) =>
          timings[field] > 0 ? (
            <span
              className={`timeseriesChart__color--${index}`}
              key={name}
              style={{ width: `${total > 0 ? (timings[field] / total) * 100 : 0}%` }}
            />
          ) : null,
        )}
      </div>
      <ul className="syntheticPhases__legend">
        {syntheticPhases.map(([name, field], index) => (
          <li className={`timeseriesChart__color--${index}`} key={name}>
            {name} <strong>{formatDuration(timings[field])}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AssertionIcon({ result }: { result: SyntheticAssertionResult }) {
  if (result.passed) return <CheckCircleIcon aria-label="Passed" className="syntheticResult__pass" size={14} weight="fill" />;
  return result.assertion.severity === "critical" ? (
    <XCircleIcon aria-label="Failed" className="syntheticResult__fail" size={14} weight="fill" />
  ) : (
    <WarningCircleIcon aria-label="Degraded" className="syntheticResult__warn" size={14} weight="fill" />
  );
}

// What a run found: its error, assertions, phases and response.
export function SyntheticRunDetails({
  assertions,
  durationMs,
  error,
  response,
  status,
  timings,
}: {
  assertions: SyntheticAssertionResult[];
  durationMs: number;
  error: string | null;
  response: SyntheticResponse | null;
  status: SyntheticRunStatus;
  timings: SyntheticTimings;
}) {
  return (
    <div className="syntheticResult">
      <div className="syntheticResult__summary">
        <SyntheticStatusBadge status={status} />
        {response ? <span>Status <strong>{response.statusCode}</strong></span> : null}
        <span>in <strong>{formatDuration(durationMs)}</strong></span>
        {response && response.redirects > 0 ? (
          <span>after {response.redirects} redirect{response.redirects === 1 ? "" : "s"}</span>
        ) : null}
      </div>
      {error ? <p className="syntheticResult__error" role="alert">{error}</p> : null}
      {assertions.length > 0 ? (
        <section>
          <h3>Assertions</h3>
          <ul className="syntheticResult__assertions">
            {assertions.map((result, index) => (
              // Assertions keep their order within a run.
              <li key={index}>
                <AssertionIcon result={result} />
                <span>{describeSyntheticAssertion(result.assertion)}</span>
                {result.actual !== null && !result.passed ? (
                  <span className="syntheticResult__actual">got {result.actual}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h3>Timing</h3>
        <SyntheticPhaseBar timings={timings} />
      </section>
      {response ? (
        <>
          {response.redirects > 0 ? (
            <section>
              <h3>Final URL</h3>
              <code className="syntheticsTable__url">{response.url}</code>
            </section>
          ) : null}
          <section>
            <h3>Response headers</h3>
            <dl className="syntheticResult__headers">
              {Object.entries(response.headers).map(([name, value]) => (
                <div key={name} style={{ display: "contents" }}>
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section>
            <h3>
              Body
              {response.bodyBytes > response.body.length || response.bodyTruncated
                ? ` (first ${response.body.length.toLocaleString()} of ${response.bodyBytes.toLocaleString()}${response.bodyTruncated ? "+" : ""} bytes)`
                : ""}
            </h3>
            {response.body ? <pre className="syntheticResult__body">{response.body}</pre> : <p className="dashboardDialog__hint">Empty.</p>}
          </section>
        </>
      ) : null}
    </div>
  );
}
