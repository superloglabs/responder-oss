import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDatabase, getDatabase } from "../src/db/client.js";

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle",
);

try {
  await migrate(getDatabase(), { migrationsFolder });
  console.info(JSON.stringify({ event: "database_migrations_complete" }));
} finally {
  await closeDatabase();
}
