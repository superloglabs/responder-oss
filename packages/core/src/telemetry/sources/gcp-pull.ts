import { z } from "zod";
import { gcpLogEntriesToOtlp, gcpMetricTypes, gcpTimeSeriesToOtlp, type GcpTimeSeries } from "./gcp-telemetry.js";

// Reads a Google Cloud project's logs and metrics with its connection's
// keyless identity, which has the Logs Viewer and Monitoring Viewer roles, and
// sends them as OTLP. Logs are read every minute and metrics every five.
// Cursors move only past data that was delivered.

const LOGGING_URL = "https://logging.googleapis.com/v2/entries:list";
const MONITORING_URL = "https://monitoring.googleapis.com/v3/projects";
// Cloud Logging and Cloud Monitoring make entries and points readable after a
// short delay, so reads stop this far behind the present.
const LOG_VISIBILITY_LAG_MS = 60_000;
const METRIC_VISIBILITY_LAG_MS = 5 * 60_000;
// A new source starts this far back, and a source that fell further behind
// skips ahead rather than replaying hours of data.
const LOG_START_MS = 5 * 60_000;
const LOG_MAX_LAG_MS = 60 * 60_000;
const METRIC_START_MS = 15 * 60_000;
const METRIC_MAX_LAG_MS = 60 * 60_000;
const METRICS_EVERY_MS = 5 * 60_000 - 15_000;
const LOG_PAGE_SIZE = 1_000;
const MAX_LOG_PAGES = 10;
const MAX_METRIC_PAGES = 3;
// Data Access audit logs are high volume and rarely useful here.
const LOG_FILTER_EXCLUSIONS = 'NOT log_id("cloudaudit.googleapis.com/data_access")';

// A read window that stopped at the page limit, resumed on the next pull.
const pageSchema = z.object({ end: z.string(), start: z.string(), token: z.string() });
type Page = z.infer<typeof pageSchema>;

export const gcpSourceStateSchema = z.object({
  logsCursor: z.string().optional(),
  logsPage: pageSchema.optional(),
  metricsCursors: z.record(z.string(), z.string()).default({}),
  metricsPages: z.record(z.string(), pageSchema).default({}),
  metricsPulledAt: z.string().optional(),
});

export type GcpSourceState = z.infer<typeof gcpSourceStateSchema>;

export type GcpRequest = (input: {
  data?: unknown;
  method: "GET" | "POST";
  url: string;
}) => Promise<unknown>;

export type GcpForward = (signal: "logs" | "metrics", payload: unknown) => Promise<boolean>;

const entriesPageSchema = z.object({
  entries: z.array(z.record(z.string(), z.unknown())).default([]),
  nextPageToken: z.string().optional(),
});

const timeSeriesPageSchema = z.object({
  nextPageToken: z.string().optional(),
  timeSeries: z.array(z.unknown()).default([]),
});

function later(cursor: string | undefined, fallback: Date, maxLagMs: number, now: Date): string {
  const floor = new Date(now.getTime() - maxLagMs);
  const parsed = cursor ? new Date(cursor) : fallback;
  return (Number.isFinite(parsed.getTime()) && parsed > floor ? (cursor ?? parsed.toISOString()) : floor.toISOString());
}

function errorText(error: unknown): string {
  const response = (error as { response?: { data?: { error?: { message?: string } } } } | null)?.response;
  return response?.data?.error?.message ?? (error instanceof Error ? error.message : String(error));
}

// Reads one window page by page. When pages remain at the limit, the window
// and its page token are returned so the next pull continues it; resuming
// with a timestamp would skip entries that share the last one's timestamp.
async function readWindow(input: {
  maxPages: number;
  page: (pageToken: string | undefined) => Promise<{ count: number; nextPageToken?: string }>;
  resume?: Page;
  window: { end: string; start: string };
}): Promise<{ count: number; page?: Page }> {
  let count = 0;
  let pageToken = input.resume?.token;
  for (let page = 0; page < input.maxPages; page += 1) {
    const result = await input.page(pageToken);
    count += result.count;
    pageToken = result.nextPageToken;
    if (!pageToken) return { count };
  }
  return { count, page: { ...input.window, token: pageToken! } };
}

async function pullLogs(input: {
  forward: GcpForward;
  gcpProjectId: string;
  now: Date;
  request: GcpRequest;
  state: GcpSourceState;
}): Promise<{ cursor: string; entries: number; page?: Page }> {
  const fresh = {
    end: new Date(input.now.getTime() - LOG_VISIBILITY_LAG_MS).toISOString(),
    start: later(input.state.logsCursor, new Date(input.now.getTime() - LOG_START_MS), LOG_MAX_LAG_MS, input.now),
  };
  let lastSent: string | undefined;
  const read = (window: { end: string; start: string }, resume?: Page) =>
    readWindow({
      maxPages: MAX_LOG_PAGES,
      page: async (pageToken) => {
        const result = entriesPageSchema.parse(
          await input.request({
            data: {
              filter: `timestamp > "${window.start}" AND timestamp <= "${window.end}" AND ${LOG_FILTER_EXCLUSIONS}`,
              orderBy: "timestamp asc",
              pageSize: LOG_PAGE_SIZE,
              resourceNames: [`projects/${input.gcpProjectId}`],
              ...(pageToken ? { pageToken } : {}),
            },
            method: "POST",
            url: LOGGING_URL,
          }),
        );
        if (result.entries.length > 0) {
          if (!(await input.forward("logs", gcpLogEntriesToOtlp(result.entries, input.gcpProjectId)))) {
            throw new Error("Telemetry ingest did not accept the logs");
          }
          const last = result.entries.at(-1)?.timestamp;
          if (typeof last === "string") lastSent = last;
        }
        return { count: result.entries.length, ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}) };
      },
      ...(resume ? { resume } : {}),
      window,
    });

  const resume = input.state.logsPage;
  let window: { end: string; start: string } = resume ?? fresh;
  let result: { count: number; page?: Page };
  try {
    if (!resume && fresh.start >= fresh.end) return { cursor: fresh.start, entries: 0 };
    result = await read(window, resume);
  } catch (error) {
    // An expired page token restarts its window. Entries sent before are sent
    // again, but none that share a timestamp with the last one are skipped.
    if (!resume || lastSent) throw error;
    window = { end: resume.end, start: resume.start };
    result = await read(window);
  }
  return result.page
    ? { cursor: lastSent ?? input.state.logsCursor ?? window.start, entries: result.count, page: result.page }
    : { cursor: window.end, entries: result.count };
}

async function pullMetrics(input: {
  forward: GcpForward;
  gcpProjectId: string;
  now: Date;
  request: GcpRequest;
  state: GcpSourceState;
}): Promise<{ cursors: Record<string, string>; failures: string[]; pages: Record<string, Page>; points: number }> {
  const end = new Date(input.now.getTime() - METRIC_VISIBILITY_LAG_MS).toISOString();
  const cursors = { ...input.state.metricsCursors };
  const pages: Record<string, Page> = {};
  const failures: string[] = [];
  let points = 0;
  for (const metricType of gcpMetricTypes) {
    const resume = input.state.metricsPages[metricType];
    const window = resume ?? {
      end,
      start: later(cursors[metricType], new Date(input.now.getTime() - METRIC_START_MS), METRIC_MAX_LAG_MS, input.now),
    };
    if (window.start >= window.end) continue;
    try {
      const result = await readWindow({
        maxPages: MAX_METRIC_PAGES,
        page: async (pageToken) => {
          const query = new URLSearchParams({
            filter: `metric.type = "${metricType}"`,
            "interval.endTime": window.end,
            "interval.startTime": window.start,
            pageSize: "1000",
            view: "FULL",
            ...(pageToken ? { pageToken } : {}),
          });
          const page = timeSeriesPageSchema.parse(
            await input.request({ method: "GET", url: `${MONITORING_URL}/${input.gcpProjectId}/timeSeries?${query}` }),
          );
          const series = page.timeSeries as GcpTimeSeries[];
          const count = series.reduce((sum, item) => sum + (item.points?.length ?? 0), 0);
          if (count > 0 && !(await input.forward("metrics", gcpTimeSeriesToOtlp(series, input.gcpProjectId)))) {
            throw new Error("Telemetry ingest did not accept the metrics");
          }
          return { count, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
        },
        ...(resume ? { resume } : {}),
        window,
      });
      points += result.count;
      if (result.page) pages[metricType] = result.page;
      else cursors[metricType] = window.end;
    } catch (error) {
      // A failed resume starts the window over on the next pull.
      failures.push(`${metricType}: ${errorText(error)}`);
    }
  }
  return { cursors, failures, pages, points };
}

export async function pullGcpSource(input: {
  forward: GcpForward;
  gcpProjectId: string;
  now?: Date;
  request: GcpRequest;
  state: Record<string, unknown>;
}): Promise<{ error: string | null; logs: number; points: number; received: boolean; state: GcpSourceState }> {
  const now = input.now ?? new Date();
  const parsed = gcpSourceStateSchema.safeParse(input.state);
  const state: GcpSourceState = parsed.success ? parsed.data : { metricsCursors: {}, metricsPages: {} };
  const errors: string[] = [];
  let logs = 0;
  let points = 0;
  let metricsRead = false;

  try {
    const result = await pullLogs({ ...input, now, state });
    state.logsCursor = result.cursor;
    if (result.page) state.logsPage = result.page;
    else delete state.logsPage;
    logs = result.entries;
  } catch (error) {
    errors.push(`Logs: ${errorText(error)}`);
  }

  const metricsDue = !state.metricsPulledAt || now.getTime() - new Date(state.metricsPulledAt).getTime() >= METRICS_EVERY_MS;
  if (metricsDue) {
    const result = await pullMetrics({ ...input, now, state });
    state.metricsCursors = result.cursors;
    state.metricsPages = result.pages;
    state.metricsPulledAt = now.toISOString();
    points = result.points;
    metricsRead = result.failures.length < gcpMetricTypes.length;
    // A metric type the project does not use is not an error, so only a
    // failure of every type is reported.
    if (!metricsRead) errors.push(`Metrics: ${result.failures[0]}`);
  }

  return {
    error: errors.length > 0 ? errors.join(" ") : null,
    logs,
    points,
    received: logs > 0 || points > 0,
    state,
  };
}
