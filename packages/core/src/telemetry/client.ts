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
  return {
    url,
    database: environment.TELEMETRY_CLICKHOUSE_DATABASE || "superlog",
    username: environment.TELEMETRY_CLICKHOUSE_USER || "default",
    password: environment.TELEMETRY_CLICKHOUSE_PASSWORD ?? "",
    // Give heavy filtered queries room to finish. Stale pooled sockets are
    // removed both by timer and immediately before reuse so an event-loop
    // delay cannot race ClickHouse's keep-alive timeout.
    request_timeout: 20_000,
    // Pages fan one request out into several reads (a service list reads
    // seven tables). Hosted ClickHouse caps the reader at a few running
    // queries for all of a cell's processes together, and rejects the rest,
    // so each process runs at most this many and queues the others.
    max_open_connections: maxOpenConnections(environment.TELEMETRY_CLICKHOUSE_MAX_CONNECTIONS),
    keep_alive: {
      enabled: true,
      idle_socket_ttl: 2_500,
      eagerly_destroy_stale_sockets: true,
    },
    clickhouse_settings: {
      // Cancel abandoned reads instead of letting them hold a server slot.
      cancel_http_readonly_queries_on_client_close: 1,
    },
  };
}

const defaultMaxOpenConnections = 2;

function maxOpenConnections(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultMaxOpenConnections;
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
