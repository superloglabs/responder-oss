import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as authSchema from "./auth-schema.js";
import * as appSchema from "./schema.js";

const schema = {
  ...authSchema,
  ...appSchema,
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

export function getDatabase(): NodePgDatabase<typeof schema> {
  if (database) return database;

  const connectionString = databaseConnectionString();
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL or DATABASE_HOST, DATABASE_NAME, DATABASE_USER, and DATABASE_PASSWORD are required",
    );
  }

  const configuredPoolSize = Number.parseInt(
    process.env.DATABASE_POOL_SIZE ?? "5",
    10,
  );
  pool = new Pool({
    connectionString,
    max: Number.isFinite(configuredPoolSize) && configuredPoolSize > 0
      ? configuredPoolSize
      : 5,
  });
  database = drizzle(pool, { schema });
  return database;
}

export async function closeDatabase(): Promise<void> {
  const activePool = pool;
  database = undefined;
  pool = undefined;
  await activePool?.end();
}
