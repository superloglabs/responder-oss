import { describe, expect, it } from "vitest";
import { telemetryClickHouseConfig, telemetryWriterClickHouseConfig } from "./client.js";

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

  it("caps the process's open connections when the store limits concurrent queries", () => {
    const store = { TELEMETRY_CLICKHOUSE_URL: "http://localhost:8123" };

    expect(telemetryClickHouseConfig({ ...store, TELEMETRY_CLICKHOUSE_MAX_CONNECTIONS: "3" })).toMatchObject({
      max_open_connections: 3,
    });
    expect(telemetryClickHouseConfig(store)).not.toHaveProperty("max_open_connections");
    for (const value of ["0", "-1", "2.5", "many"]) {
      expect(telemetryClickHouseConfig({ ...store, TELEMETRY_CLICKHOUSE_MAX_CONNECTIONS: value })).not.toHaveProperty(
        "max_open_connections",
      );
    }
  });
});

describe("telemetry ClickHouse writer config", () => {
  it("is absent without a writer user, so reading credentials never write", () => {
    expect(telemetryWriterClickHouseConfig({ TELEMETRY_CLICKHOUSE_URL: "http://clickhouse:8123", TELEMETRY_CLICKHOUSE_USER: "reader" })).toBeNull();
    expect(telemetryWriterClickHouseConfig({ TELEMETRY_CLICKHOUSE_WRITER_USER: "events" })).toBeNull();
  });

  it("writes to the store as the writer user", () => {
    expect(telemetryWriterClickHouseConfig({
      TELEMETRY_CLICKHOUSE_DATABASE: "telemetry",
      TELEMETRY_CLICKHOUSE_PASSWORD: "reader-secret",
      TELEMETRY_CLICKHOUSE_URL: "http://clickhouse:8123",
      TELEMETRY_CLICKHOUSE_USER: "reader",
      TELEMETRY_CLICKHOUSE_WRITER_PASSWORD: "writer-secret",
      TELEMETRY_CLICKHOUSE_WRITER_USER: "events",
    })).toMatchObject({ database: "telemetry", password: "writer-secret", url: "http://clickhouse:8123", username: "events" });
  });
});
