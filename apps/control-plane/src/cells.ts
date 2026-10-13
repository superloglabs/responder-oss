import { useEffect, useState } from "react";

export type Cell = { id: string; label: string; url: string };

export type CellDirectory = {
  cells: Cell[];
  cookieDomain: string | null;
  current: string | null;
};

// Names the cell a visitor last used. The edge sends /app on any cell's host
// to that cell, so returning visitors reach their own data.
const cellCookieName = "responder_cell";
const cellCookieMaxAgeSeconds = 365 * 24 * 60 * 60;

export function cellCookie(
  id: string,
  cookieDomain: string | null,
  secure: boolean,
): string {
  return [
    `${cellCookieName}=${encodeURIComponent(id)}`,
    `Max-Age=${cellCookieMaxAgeSeconds}`,
    "Path=/",
    "SameSite=Lax",
    ...(cookieDomain ? [`Domain=${cookieDomain}`] : []),
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

// The cookie routes the visitor to the region they chose, which the service
// needs to work, so it is set without a consent category.
export function rememberCell(id: string, cookieDomain: string | null): void {
  document.cookie = cellCookie(
    id,
    cookieDomain,
    window.location.protocol === "https:",
  );
}

export function cellSwitchUrl(cell: Cell, location: URL): string {
  const target = new URL(location.pathname + location.search, cell.url);
  for (const parameter of ["error", "error_description"]) {
    target.searchParams.delete(parameter);
  }
  return target.toString();
}

// One request per page load, shared by every caller. A failed request is
// retried by the next caller.
let directoryRequest: Promise<CellDirectory | null> | undefined;

function requestCellDirectory(): Promise<CellDirectory | null> {
  directoryRequest ??= fetch("/api/cells")
    .then((response) => (response.ok ? (response.json() as Promise<CellDirectory>) : null))
    .catch(() => null)
    .then((directory) => {
      if (!directory) directoryRequest = undefined;
      return directory;
    });
  return directoryRequest;
}

export function useCellDirectory(enabled = true): CellDirectory | null {
  const [directory, setDirectory] = useState<CellDirectory | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void requestCellDirectory().then((value) => {
      if (!cancelled && value) setDirectory(value);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return directory;
}
