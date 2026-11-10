import { randomUUID } from "node:crypto";
import net from "node:net";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Run against a disposable PostgreSQL database only.
const testUrl = process.env.TEST_JOB_LISTENER_DATABASE_URL;

// A TCP proxy to the database that can stop forwarding the connections it has
// open, like a database host that stops answering.
function databaseProxy(target: URL) {
  const pairs: { client: net.Socket; upstream: net.Socket }[] = [];
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    client.pipe(upstream);
    upstream.pipe(client);
    const ignore = () => undefined;
    client.on("error", ignore);
    upstream.on("error", ignore);
    pairs.push({ client, upstream });
  });
  return {
    async listen() {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as net.AddressInfo;
      const url = new URL(target);
      url.hostname = "127.0.0.1";
      url.port = String(address.port);
      return url.toString();
    },
    // Stops forwarding on every open connection; new connections still work.
    freeze() {
      for (const { client, upstream } of pairs) {
        client.unpipe(upstream);
        upstream.unpipe(client);
        client.pause();
        upstream.pause();
      }
    },
    async close() {
      for (const { client, upstream } of pairs.splice(0)) {
        client.destroy();
        upstream.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const originalQuery = pg.Client.prototype.query;

describe.skipIf(!testUrl)("job queue LISTEN/NOTIFY listener (PostgreSQL)", () => {
  const proxy = databaseProxy(new URL(testUrl ?? "postgres://localhost"));
  const uncaught: unknown[] = [];
  const recordUncaught = (error: unknown) => uncaught.push(error);
  let boss: PgBoss;

  beforeAll(async () => {
    process.on("uncaughtException", recordUncaught);
    boss = new PgBoss({
      connectionString: await proxy.listen(),
      notifyHeartbeatIntervalMs: 100,
      notifyHeartbeatTimeoutMs: 200,
      notifyKeepAliveInitialDelayMs: 100,
      schedule: false,
      schema: `listener_${randomUUID().replaceAll("-", "")}`,
      supervise: false,
      useListenNotify: true,
    });
  });

  afterAll(async () => {
    await boss.stop({ graceful: false }).catch(() => undefined);
    await proxy.close();
    process.off("uncaughtException", recordUncaught);
  });

  // On 2026-11-10 a database host stopped answering. The listener's heartbeat
  // timed out and pg-boss discarded its client after removing every listener.
  // About 15 minutes later the client's socket timed out with no error
  // listener, and the worker process crashed.
  it("survives a socket timeout on the listener client it discarded", async () => {
    const listeners: pg.Client[] = [];
    const query = vi.spyOn(pg.Client.prototype, "query");
    query.mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      if (typeof args[0] === "string" && args[0].startsWith("LISTEN ")) listeners.push(this);
      return originalQuery.apply(this, args as never);
    });
    const errors: Error[] = [];
    boss.on("error", (error) => errors.push(error));
    await boss.start();
    expect(listeners).toHaveLength(1);

    proxy.freeze();
    await expect
      .poll(() => errors.map((error) => error.message), { interval: 50, timeout: 5_000 })
      .toContain("LISTEN/NOTIFY heartbeat timed out");
    query.mockRestore();

    // The production socket failed this way about 15 minutes later. pg
    // ignores a reset while a client ends, but not a timeout.
    const stream = (listeners[0] as unknown as { connection: { stream: net.Socket } }).connection.stream;
    stream.emit("error", Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT", errno: -110, syscall: "read" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(uncaught).toEqual([]);
  });
});
