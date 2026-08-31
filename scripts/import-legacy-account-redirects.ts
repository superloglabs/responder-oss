import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { closeDatabase, getDatabase } from "../packages/core/src/db/client.js";
import { normalizeLegacyEmail } from "../packages/core/src/db/legacy-account-redirect.js";
import { legacyAccountRedirect } from "../packages/core/src/db/schema.js";

const requiredColumns = ["old_user_id", "email", "redirect_flag"] as const;

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value);
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  return values;
}

function parseManifest(contents: string) {
  const lines = contents.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) throw new Error("Redirect manifest must contain a header and rows");
  const header = parseCsvLine(lines[0]);
  for (const column of requiredColumns) {
    if (!header.includes(column)) throw new Error(`Redirect manifest is missing ${column}`);
  }
  const indexes = Object.fromEntries(header.map((column, index) => [column, index]));
  const seen = new Set<string>();
  return lines.slice(1).map((line, rowIndex) => {
    const values = parseCsvLine(line);
    const email = normalizeLegacyEmail(values[indexes.email] ?? "");
    const oldUserId = values[indexes.old_user_id]?.trim() ?? "";
    const redirectFlag = values[indexes.redirect_flag]?.trim().toLowerCase();
    if (!oldUserId || !email) throw new Error(`Row ${rowIndex + 2} is missing an id or email`);
    if (redirectFlag !== "true") {
      throw new Error(`Row ${rowIndex + 2} is not a TRUE redirect row`);
    }
    if (seen.has(email)) throw new Error(`Duplicate normalized email at row ${rowIndex + 2}`);
    seen.add(email);
    return { emailNormalized: email, oldUserId };
  });
}

const input = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
const apply = process.argv.includes("--apply");
if (!input) {
  console.error("Usage: pnpm legacy-redirect:import <manifest.csv> [--apply]");
  process.exit(2);
}

const path = resolve(input);
const contents = await readFile(path, "utf8");
const rows = parseManifest(contents);
const sourceSnapshot = createHash("sha256").update(contents).digest("hex");

console.info(
  JSON.stringify({
    apply,
    event: "legacy_account_redirect_manifest_validated",
    rows: rows.length,
    sourceFile: basename(path),
    sourceSnapshot,
  }),
);
await closeDatabase();

if (!apply) {
  console.info("Dry run only. Re-run with --apply to update the marker table.");
  process.exit(0);
}

const database = getDatabase();
await database.transaction(async (transaction) => {
  const now = new Date();
  await transaction
    .update(legacyAccountRedirect)
    .set({ redirectEnabled: false, sourceSnapshot, updatedAt: now });
  for (let index = 0; index < rows.length; index += 100) {
    const batch = rows.slice(index, index + 100).map((row) => ({
      ...row,
      redirectEnabled: true,
      sourceSnapshot,
      createdAt: now,
      updatedAt: now,
    }));
    await transaction
      .insert(legacyAccountRedirect)
      .values(batch)
      .onConflictDoUpdate({
        target: legacyAccountRedirect.emailNormalized,
        set: {
          // The old user id is stable for a normalized email. Keep the
          // previously imported id on conflict and refresh routing metadata.
          oldUserId: legacyAccountRedirect.oldUserId,
          redirectEnabled: true,
          sourceSnapshot,
          updatedAt: now,
        },
      });
  }
});

console.info(
  JSON.stringify({
    event: "legacy_account_redirect_manifest_applied",
    rows: rows.length,
    sourceSnapshot,
  }),
);
