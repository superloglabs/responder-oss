import { describe, expect, it } from "vitest";
import { telemetryClickHouseConfig } from "./client.js";

describe("telemetry ClickHouse config", () => {
  it("is absent when no telemetry store is configured", () => {
    expect(telemetryClickHouseConfig({})).toBeNull();
  });

  it("reads the store location and credentials from the environment", () => {
    const config = telemetryClickHouseConfig({
      TELEMETRY_CLICKHOUSE_DATABASE: "telemetry",
      TELEMETRY_CLICKHOUSE_PASSWORD: "secret",
      TELEMETRY_CLICKHOUSE_URL: "https://clickhouse.internal:8443",
      TELEMETRY_CLICKHOUSE_USER: "reader",
    });

    expect(config).toMatchObject({
      database: "telemetry",
      password: "secret",
      url: "https://clickhouse.internal:8443",
      username: "reader",
    });
  });

  it("defaults to the ingest pipeline's database", () => {
    expect(
      telemetryClickHouseConfig({ TELEMETRY_CLICKHOUSE_URL: "http://localhost:8123" }),
    ).toMatchObject({ database: "superlog", username: "default", password: "" });
  });
});
