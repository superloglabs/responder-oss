import { z } from "zod";

// A hosted deployment can run several regional cells, each a complete copy of
// the application with its own data. The directory tells the sign-in page
// which cells exist and which one it is running in.
export type Cell = {
  id: string;
  label: string;
  url: string;
};

export type CellDirectory = {
  cells: Cell[];
  // The parent domain shared by every cell, where the chosen cell is
  // remembered. Null keeps the choice on the current host only.
  cookieDomain: string | null;
  current: string;
};

const cellIdPattern = /^[a-z][a-z0-9-]{0,31}$/u;

const cellListSchema = z.array(
  z.object({
    id: z.string(),
    label: z.string().trim().min(1).max(64),
    url: z.string(),
  }),
);

function cellOrigin(id: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Cell ${id} must be an HTTPS origin`);
  }
  const local = url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (
    (url.protocol !== "https:" && !local) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Cell ${id} must be an HTTPS origin`);
  }
  return url.origin;
}

function coversHost(cookieDomain: string, hostname: string): boolean {
  const domain = cookieDomain.replace(/^\./u, "");
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

// Reads RESPONDER_CELLS (a JSON list of { id, label, url }), RESPONDER_CELL_ID,
// and the optional RESPONDER_CELL_COOKIE_DOMAIN. Returns null for a
// single-cell deployment and throws on an invalid configuration.
export function cellDirectory(
  environment: NodeJS.ProcessEnv = process.env,
): CellDirectory | null {
  const configured = environment.RESPONDER_CELLS?.trim();
  if (!configured) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(configured);
  } catch {
    throw new Error("RESPONDER_CELLS must be a JSON list of cells");
  }
  const list = cellListSchema.safeParse(parsed);
  if (!list.success || list.data.length === 0) {
    throw new Error("RESPONDER_CELLS must be a JSON list of cells");
  }

  const cells: Cell[] = [];
  for (const cell of list.data) {
    if (!cellIdPattern.test(cell.id)) {
      throw new Error(`Cell identifier ${JSON.stringify(cell.id)} is invalid`);
    }
    if (cells.some((existing) => existing.id === cell.id)) {
      throw new Error(`RESPONDER_CELLS lists a duplicate cell ${cell.id}`);
    }
    cells.push({ id: cell.id, label: cell.label, url: cellOrigin(cell.id, cell.url) });
  }

  const current = environment.RESPONDER_CELL_ID?.trim() ?? "";
  if (!cells.some((cell) => cell.id === current)) {
    throw new Error(
      `RESPONDER_CELL_ID ${JSON.stringify(current)} is not one of RESPONDER_CELLS`,
    );
  }

  const cookieDomain =
    environment.RESPONDER_CELL_COOKIE_DOMAIN?.trim().toLowerCase() || null;
  if (cookieDomain) {
    // Browsers drop cookies scoped to a top-level domain. Deeper public
    // suffixes such as co.uk are not detected here.
    if (cookieDomain.replace(/^\./u, "").split(".").length < 2) {
      throw new Error(
        `RESPONDER_CELL_COOKIE_DOMAIN ${cookieDomain} must be a registrable domain`,
      );
    }
    for (const cell of cells) {
      if (!coversHost(cookieDomain, new URL(cell.url).hostname)) {
        throw new Error(
          `RESPONDER_CELL_COOKIE_DOMAIN ${cookieDomain} does not cover cell ${cell.id}`,
        );
      }
    }
  }

  return { cells, cookieDomain, current };
}
