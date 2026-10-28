import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as authSchema from "./auth-schema.js";
import * as consentSchema from "./consent-schema.js";
import * as appSchema from "./schema.js";

const schema = {
  ...authSchema,
  ...appSchema,
  ...consentSchema,
};

let database: NodePgDatabase<typeof schema> | undefined;
let pool: Pool | undefined;

export function databaseConnectionString(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  if (environment.DATABASE_URL) return environment.DATABASE_URL;

  const host = environment.DATABASE_HOST;
  const name = environment.DATABASE_NAME;
  const password = environment.DATABASE_PASSWORD;
  const user = environment.DATABASE_USER;
  if (!host || !name || !password || !user) return null;

  const port = environment.DATABASE_PORT ?? "5432";
  const sslMode = environment.DATABASE_SSL_MODE ?? "require";
  const sslRootCertificate = environment.DATABASE_SSL_ROOT_CERT;
  const sslParameters = new URLSearchParams({ sslmode: sslMode });
  if (sslRootCertificate) {
    sslParameters.set("sslrootcert", sslRootCertificate);
  }
  return (
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${host}:${port}/${encodeURIComponent(name)}` +
    `?${sslParameters.toString()}`
  );
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// Bounds every wait on the database. When the server stops answering without
// closing its sockets, as during an RDS host recovery, a pooled connection
// would otherwise wait forever and hold its pool slot. Keepalive probes find
// those sockets, the query timeout fails a query that gets no answer, and the
// connection timeout stops callers queueing forever for a free connection.
export function databasePoolOptions(
  environment: NodeJS.ProcessEnv = process.env,
): {
  connectionTimeoutMillis: number;
  keepAlive: true;
  keepAliveInitialDelayMillis: number;
  max: number;
  query_timeout: number;
} {
  return {
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    max: positiveInteger(environment.DATABASE_POOL_SIZE, 5),
    query_timeout: positiveInteger(environment.DATABASE_QUERY_TIMEOUT_MS, 120_000),
  };
}

export function getDatabase(): NodePgDatabase<typeof schema> {
  if (database) return database;

  const connectionString = databaseConnectionString();
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL or DATABASE_HOST, DATABASE_NAME, DATABASE_USER, and DATABASE_PASSWORD are required",
    );
  }

  pool = new Pool({ connectionString, ...databasePoolOptions() });
  database = drizzle(pool, { schema });
  return database;
}

// Runs a trivial query through the application pool.
export async function checkDatabase(): Promise<void> {
  await getDatabase().execute(sql`select 1`);
}

export async function closeDatabase(): Promise<void> {
  const activePool = pool;
  database = undefined;
  pool = undefined;
  await activePool?.end();
}
