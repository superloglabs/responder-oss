import type { SyntheticRunResult } from "./types.js";

// A run as OTLP metrics, for the check's telemetry project. Dashboards and
// alerts read them like any other metric.

type Attribute = { key: string; value: { intValue: string } | { stringValue: string } };

function attribute(key: string, value: number | string): Attribute {
  return { key, value: typeof value === "number" ? { intValue: String(Math.trunc(value)) } : { stringValue: value } };
}

const phases = [
  ["dns", "dnsMs"],
  ["connect", "connectMs"],
  ["tls", "tlsMs"],
  ["first_byte", "firstByteMs"],
  ["download", "downloadMs"],
] as const;

export function syntheticRunMetrics(
  check: { id: string; method: string; name: string; url: string },
  run: SyntheticRunResult,
  location: string,
): unknown {
  const time = String(BigInt(Date.parse(run.startedAt)) * 1_000_000n);
  const attributes = [
    attribute("synthetic_check.id", check.id),
    attribute("synthetic_check.name", check.name),
    attribute("synthetic_check.location", location),
    attribute("synthetic_check.status", run.status),
    attribute("http.request.method", check.method),
    attribute("server.address", new URL(check.url).hostname),
    ...(run.response ? [attribute("http.response.status_code", run.response.statusCode)] : []),
  ];
  const gauge = (name: string, unit: string, description: string, points: Array<{ attributes: Attribute[]; value: number }>) => ({
    description,
    gauge: { dataPoints: points.map((point) => ({ asDouble: point.value, attributes: point.attributes, timeUnixNano: time })) },
    name,
    unit,
  });
  return {
    resourceMetrics: [
      {
        resource: { attributes: [attribute("service.name", "superlog-synthetics")] },
        scopeMetrics: [
          {
            metrics: [
              gauge("synthetic_check.up", "1", "1 when the run passed or was degraded, 0 when it failed", [
                { attributes, value: run.status === "failed" ? 0 : 1 },
              ]),
              gauge("synthetic_check.duration", "ms", "How long the run's request took", [{ attributes, value: run.durationMs }]),
              gauge(
                "synthetic_check.phase.duration",
                "ms",
                "How long each phase of the run's request took",
                phases.map(([phase, field]) => ({
                  attributes: [...attributes, attribute("synthetic_check.phase", phase)],
                  value: run.timings[field],
                })),
              ),
            ],
            scope: { name: "superlog.synthetics" },
          },
        ],
      },
    ],
  };
}
