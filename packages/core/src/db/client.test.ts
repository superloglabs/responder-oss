import type { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeDatabase,
  databaseConnectionString,
  databasePoolOptions,
  getDatabase,
} from "./client.js";

describe("database connection configuration", () => {
  it("uses DATABASE_URL when it is present", () => {
    expect(
      databaseConnectionString({ DATABASE_URL: "postgresql://direct" }),
    ).toBe("postgresql://direct");
  });

  it("builds an encoded RDS connection string from separate secret fields", () => {
    expect(
      databaseConnectionString({
        DATABASE_HOST: "database.internal",
        DATABASE_NAME: "responder",
        DATABASE_PASSWORD: "secret:/?#[]@!",
        DATABASE_PORT: "5432",
        DATABASE_SSL_MODE: "require",
        DATABASE_SSL_ROOT_CERT: "/app/certs/global bundle.pem",
        DATABASE_USER: "responder app",
      }),
    ).toBe(
      "postgresql://responder%20app:secret%3A%2F%3F%23%5B%5D%40!" +
        "@database.internal:5432/responder?sslmode=require&" +
        "sslrootcert=%2Fapp%2Fcerts%2Fglobal+bundle.pem",
    );
  });

  it("returns null when the split configuration is incomplete", () => {
    expect(databaseConnectionString({ DATABASE_HOST: "database.internal" })).toBeNull();
  });

  it("bounds connection and query waits and probes idle sockets", () => {
    expect(databasePoolOptions({})).toEqual({
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      max: 5,
      query_timeout: 120_000,
    });
  });

  it("reads the pool size and query timeout from the environment", () => {
    expect(
      databasePoolOptions({ DATABASE_POOL_SIZE: "8", DATABASE_QUERY_TIMEOUT_MS: "30000" }),
    ).toMatchObject({ max: 8, query_timeout: 30_000 });
    expect(
      databasePoolOptions({ DATABASE_POOL_SIZE: "0", DATABASE_QUERY_TIMEOUT_MS: "soon" }),
    ).toMatchObject({ max: 5, query_timeout: 120_000 });
  });
});

describe("database pool", () => {
  afterEach(async () => {
    await closeDatabase();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  // On 2026-11-10 an RDS failover ended every idle connection with 57P01 and
  // the unhandled pool error crashed the worker, Signal worker, and API.
  it("logs an idle client's error instead of crashing", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://responder@127.0.0.1:1/responder");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = Object.assign(new Error("terminating connection due to administrator command"), {
      code: "57P01",
    });

    const pool = (getDatabase() as unknown as { $client: EventEmitter }).$client;

    expect(() => pool.emit("error", error)).not.toThrow();
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        code: "57P01",
        errorMessage: "terminating connection due to administrator command",
        event: "database_idle_client_error",
      }),
    );
  });
});
