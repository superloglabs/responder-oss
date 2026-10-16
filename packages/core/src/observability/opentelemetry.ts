import { hostname } from "node:os";
import { format } from "node:util";
import {
  context,
  metrics,
  propagation,
  trace,
  type Attributes,
  type AttributeValue,
  type Context,
  type ContextManager,
  type Link,
  type SpanKind,
} from "@opentelemetry/api";
import { logs, SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node";
import { resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SamplingDecision,
  type Sampler,
  type SamplingResult,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import type { Client } from "@sentry/core";
import {
  SentryPropagator,
  SentrySampler,
  SentrySpanProcessor,
} from "@sentry/opentelemetry";
import { sentryEnvironment, sentryRelease } from "./sentry.js";

export type TelemetryEnvironment = Record<string, string | undefined>;

export interface NodeTelemetryOptions {
  /** Used when OTEL_SERVICE_NAME is not set. */
  serviceName: string;
  environment?: TelemetryEnvironment;
  /**
   * The Sentry client, initialized with `skipOpenTelemetrySetup: true`. Its
   * sampler decides which traces are recorded, and every recorded span goes to
   * both Sentry and the OTLP endpoint.
   */
  sentryClient: Client;
  /** `Sentry.SentryContextManager` from the application's Sentry SDK. */
  sentryContextManager: ContextManager;
}

export interface NodeTelemetry {
  /** Exports buffered telemetry, waiting at most `timeout` milliseconds. */
  flush(timeout?: number): Promise<void>;
  shutdown(): Promise<void>;
}

const signalEndpointNames = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
] as const;

// Exporting is on when an OTLP endpoint is configured with the standard
// OpenTelemetry variables, and OTEL_SDK_DISABLED is not "true".
export function otlpExportConfigured(
  environment: TelemetryEnvironment = process.env,
): boolean {
  if (environment.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") {
    return false;
  }
  return signalEndpointNames.some((name) => Boolean(environment[name]?.trim()));
}

// Comma-separated key=value pairs, as in OTEL_RESOURCE_ATTRIBUTES and
// OTEL_EXPORTER_OTLP_HEADERS. Keys and values may be percent-encoded.
function keyValuePairs(value: string | undefined): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (const pair of value?.split(",") ?? []) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    try {
      const key = decodeURIComponent(pair.slice(0, separator).trim());
      if (key) pairs[key] = decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      // Skip a pair that is not valid percent-encoding.
    }
  }
  return pairs;
}

export type OtlpSignal = "logs" | "metrics" | "traces";

// The OTLP/HTTP URL for one signal, following the OpenTelemetry exporter
// variables: the signal's own endpoint as written, otherwise the base
// endpoint with /v1/<signal> appended.
export function otlpSignalEndpoint(
  signal: OtlpSignal,
  environment: TelemetryEnvironment = process.env,
): string | null {
  if (!otlpExportConfigured(environment)) return null;
  const own = environment[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`]?.trim();
  if (own) return own;
  const base = environment.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return base ? `${base.replace(/\/+$/u, "")}/v1/${signal}` : null;
}

// The headers the OTLP exporters send for one signal, such as the ingest key.
export function otlpSignalHeaders(
  signal: OtlpSignal,
  environment: TelemetryEnvironment = process.env,
): Record<string, string> {
  return {
    ...keyValuePairs(environment.OTEL_EXPORTER_OTLP_HEADERS),
    ...keyValuePairs(environment[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_HEADERS`]),
  };
}

export function nodeTelemetryResource(
  serviceName: string,
  environment: TelemetryEnvironment = process.env,
): Resource {
  const release = sentryRelease(environment);
  const region = environment.AWS_REGION?.trim();
  const configured = keyValuePairs(environment.OTEL_RESOURCE_ATTRIBUTES);
  return resourceFromAttributes({
    "deployment.environment.name": sentryEnvironment(environment),
    "host.name": hostname(),
    ...(release ? { [ATTR_SERVICE_VERSION]: release } : {}),
    ...(region ? { "cloud.region": region } : {}),
    // OTEL_RESOURCE_ATTRIBUTES adds to or overrides the defaults above.
    ...configured,
    [ATTR_SERVICE_NAME]:
      environment.OTEL_SERVICE_NAME?.trim() ||
      configured[ATTR_SERVICE_NAME] ||
      serviceName,
  });
}

// A parent in this process. Sentry gives requests it does not trace a remote
// parent from their propagation context, which does not count.
function hasLocalParent(parentContext: Context): boolean {
  const parent = trace.getSpanContext(parentContext);
  return Boolean(parent && trace.isSpanContextValid(parent) && !parent.isRemote);
}

function isQuerySpan(spanName: string, attributes: Attributes): boolean {
  return (
    attributes["db.system"] !== undefined ||
    attributes["db.system.name"] !== undefined ||
    spanName.startsWith("pg.") ||
    spanName.startsWith("pg-pool.")
  );
}

function isMiddlewareSpan(attributes: Attributes): boolean {
  const operation = attributes["sentry.op"];
  return typeof operation === "string" && operation.startsWith("middleware.");
}

// Database queries and middleware outside a traced request or job, such as
// queue polling or a health check, would each start a trace of one span.
// They are dropped instead.
export class DetachedSpanSampler implements Sampler {
  constructor(private readonly inner: Sampler) {}

  shouldSample(
    parentContext: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    if (
      (isQuerySpan(spanName, attributes) || isMiddlewareSpan(attributes)) &&
      !hasLocalParent(parentContext)
    ) {
      return { decision: SamplingDecision.NOT_RECORD };
    }
    return this.inner.shouldSample(
      parentContext,
      traceId,
      spanName,
      spanKind,
      attributes,
      links,
    );
  }

  toString(): string {
    return `DetachedSpanSampler{${this.inner.toString()}}`;
  }
}

const maxLogBodyLength = 16_000;
const maxLogAttributeLength = 4_000;
const consoleSeverities = {
  debug: { number: SeverityNumber.DEBUG, text: "DEBUG" },
  error: { number: SeverityNumber.ERROR, text: "ERROR" },
  info: { number: SeverityNumber.INFO, text: "INFO" },
  log: { number: SeverityNumber.INFO, text: "INFO" },
  warn: { number: SeverityNumber.WARN, text: "WARN" },
} as const;
type ConsoleMethod = keyof typeof consoleSeverities;

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function logAttributeValue(value: unknown): AttributeValue | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return truncate(value, maxLogAttributeLength);
  if (typeof value === "number" || typeof value === "boolean") return value;
  try {
    return truncate(JSON.stringify(value), maxLogAttributeLength);
  } catch {
    return undefined;
  }
}

// The applications log one JSON object per line, such as
// {"event":"control_plane_listening","port":3000}. Its event becomes the log
// body and its fields become attributes, so they can be filtered on.
export function consoleLogRecord(args: readonly unknown[]): {
  attributes: Attributes;
  body: string;
} {
  if (args.length === 1 && typeof args[0] === "string") {
    const line = args[0].trim();
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const attributes: Attributes = {};
          for (const [key, value] of Object.entries(parsed)) {
            const attribute = logAttributeValue(value);
            if (attribute !== undefined) attributes[key] = attribute;
          }
          const event = (parsed as Record<string, unknown>).event;
          return {
            attributes,
            body: typeof event === "string" ? event : truncate(line, maxLogBodyLength),
          };
        }
      } catch {
        // Not JSON after all; send the line as written.
      }
    }
  }
  return { attributes: {}, body: truncate(format(...args), maxLogBodyLength) };
}

// Sends each console line as an OpenTelemetry log record as well, with the
// active trace attached. The line is still written to stdout or stderr first.
export function forwardConsoleToLogger(
  logger: Logger,
  target: Console = console,
): () => void {
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  let emitting = false;
  for (const method of Object.keys(consoleSeverities) as ConsoleMethod[]) {
    const original = target[method].bind(target) as (...args: unknown[]) => void;
    originals.set(method, target[method] as (...args: unknown[]) => void);
    target[method] = (...args: unknown[]) => {
      original(...args);
      if (emitting) return;
      emitting = true;
      try {
        const { attributes, body } = consoleLogRecord(args);
        const severity = consoleSeverities[method];
        logger.emit({
          attributes,
          body,
          context: context.active(),
          severityNumber: severity.number,
          severityText: severity.text,
        });
      } catch {
        // Telemetry must never break logging.
      } finally {
        emitting = false;
      }
    };
  }
  return () => {
    for (const [method, original] of originals) target[method] = original;
  };
}

// Starts trace, metric, and log export over OTLP. Traces use one tracer
// provider for Sentry and OTLP, so both receive the same sampled spans.
export function startNodeTelemetry(options: NodeTelemetryOptions): NodeTelemetry {
  const environment = options.environment ?? process.env;
  const resource = nodeTelemetryResource(options.serviceName, environment);

  const tracerProvider = new BasicTracerProvider({
    resource,
    sampler: new DetachedSpanSampler(new SentrySampler(options.sentryClient)),
    spanProcessors: [
      new SentrySpanProcessor({ client: options.sentryClient }),
      new BatchSpanProcessor(new OTLPTraceExporter()),
    ],
  });
  trace.setGlobalTracerProvider(tracerProvider);
  propagation.setGlobalPropagator(new SentryPropagator());
  context.setGlobalContextManager(options.sentryContextManager);

  const meterProvider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 60_000,
      }),
    ],
    resource,
  });
  metrics.setGlobalMeterProvider(meterProvider);
  const runtimeMetrics = new RuntimeNodeInstrumentation();
  runtimeMetrics.setMeterProvider(meterProvider);

  const loggerProvider = new LoggerProvider({
    processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    resource,
  });
  logs.setGlobalLoggerProvider(loggerProvider);
  const restoreConsole = forwardConsoleToLogger(
    loggerProvider.getLogger("console"),
  );

  return {
    async flush(timeout = 2_000) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([
          tracerProvider.forceFlush(),
          meterProvider.forceFlush(),
          loggerProvider.forceFlush(),
        ]),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeout);
        }),
      ]);
      clearTimeout(timer);
    },
    async shutdown() {
      restoreConsole();
      runtimeMetrics.disable();
      await Promise.allSettled([
        tracerProvider.shutdown(),
        meterProvider.shutdown(),
        loggerProvider.shutdown(),
      ]);
    },
  };
}
