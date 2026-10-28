import {
  type ClickHouseClient,
  type ClickHouseClientConfigOptions,
  createClient,
} from "@clickhouse/client";

export type TelemetryClient = ClickHouseClient;

let client: ClickHouseClient | undefined;

// Telemetry is optional. Without TELEMETRY_CLICKHOUSE_URL the application has
// no telemetry store and the telemetry features stay unavailable.
export function telemetryClickHouseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ClickHouseClientConfigOptions | null {
  const url = environment.TELEMETRY_CLICKHOUSE_URL;
  if (!url) return null;
  const maxConnections = Number(environment.TELEMETRY_CLICKHOUSE_MAX_CONNECTIONS);
  return {
    url,
    database: environment.TELEMETRY_CLICKHOUSE_DATABASE || "superlog",
    username: environment.TELEMETRY_CLICKHOUSE_USER || "default",
    password: environment.TELEMETRY_CLICKHOUSE_PASSWORD ?? "",
    // Give heavy filtered queries room to finish. Stale pooled sockets are
    // removed both by timer and immediately before reuse so an event-loop
    // delay cannot race ClickHouse's keep-alive timeout.
    request_timeout: 20_000,
    keep_alive: {
      enabled: true,
      idle_socket_ttl: 2_500,
      eagerly_destroy_stale_sockets: true,
    },
    clickhouse_settings: {
      // Cancel abandoned reads instead of letting them hold a server slot.
      cancel_http_readonly_queries_on_client_close: 1,
    },
    // A store that limits the user's concurrent queries rejects the ones over
    // the limit. With fewer open connections than that, extra queries wait
    // here for a free connection instead. The request timeout starts once a
    // query has its connection.
    ...(Number.isInteger(maxConnections) && maxConnections > 0 ? { max_open_connections: maxConnections } : {}),
  };
}

let writerClient: ClickHouseClient | undefined;

// The application writes one telemetry table, error_issue_events, as a user
// that may only insert into it. Without TELEMETRY_CLICKHOUSE_WRITER_USER the
// cell does not record error issue events.
export function telemetryWriterClickHouseConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ClickHouseClientConfigOptions | null {
  const url = environment.TELEMETRY_CLICKHOUSE_URL;
  const username = environment.TELEMETRY_CLICKHOUSE_WRITER_USER;
  if (!url || !username) return null;
  return {
    url,
    database: environment.TELEMETRY_CLICKHOUSE_DATABASE || "superlog",
    username,
    password: environment.TELEMETRY_CLICKHOUSE_WRITER_PASSWORD ?? "",
    request_timeout: 20_000,
    keep_alive: {
      enabled: true,
      idle_socket_ttl: 2_500,
      eagerly_destroy_stale_sockets: true,
    },
  };
}

export function getTelemetryWriterClient(): ClickHouseClient | null {
  if (writerClient) return writerClient;
  const config = telemetryWriterClickHouseConfig();
  if (!config) return null;
  writerClient = createClient(config);
  return writerClient;
}

export function getTelemetryClient(): ClickHouseClient | null {
  if (client) return client;
  const config = telemetryClickHouseConfig();
  if (!config) return null;
  client = createClient(config);
  return client;
}

// Where this cell's OpenTelemetry collector receives OTLP over HTTP. Without
// it, the cell does not accept telemetry from applications.
export function telemetryCollectorUrl(environment: NodeJS.ProcessEnv = process.env): string | null {
  const url = environment.TELEMETRY_COLLECTOR_URL?.trim();
  return url ? url.replace(/\/+$/u, "") : null;
}
