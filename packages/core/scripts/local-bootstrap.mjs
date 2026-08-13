import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const sql = await readFile(
  new URL("../../../scripts/local-bootstrap.sql", import.meta.url),
  "utf8",
);
const client = new pg.Client({ connectionString });

try {
  await client.connect();
  await client.query(sql);
} finally {
  await client.end();
}
