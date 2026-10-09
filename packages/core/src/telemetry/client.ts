import {
  type ClickHouseClient,
  type ClickHouseClientConfigOptions,
  createClient,
} from "@clickhouse/client";

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

export function getTelemetryClient(): ClickHouseClient | null {
  if (client) return client;
  const config = telemetryClickHouseConfig();
  if (!config) return null;
  client = createClient(config);
  return client;
}
