import type { MiddlewareHandler } from "hono";
import { type CellDirectory, cellDirectory } from "../../../../packages/core/src/cells.js";

// Providers redirect OAuth callbacks to one registered address. The state a
// cell creates names that cell's own callback URL, so a callback reaching
// another cell is sent on to the cell holding the user's session and the
// pending connection. Only the origin of a configured cell is taken from the
// state; the path and query stay those of the request.
export function cellCallbackRedirect(
  requestUrl: URL,
  directory: CellDirectory | null,
): string | null {
  if (!directory) return null;
  const [version, encodedUrl] = requestUrl.searchParams.get("state")?.split(".", 3) ?? [];
  if (version !== "responder-v1" || !encodedUrl) return null;

  let origin: string;
  try {
    origin = new URL(Buffer.from(encodedUrl, "base64url").toString("utf8")).origin;
  } catch {
    return null;
  }
  const cell = directory.cells.find(
    (candidate) => candidate.id !== directory.current && candidate.url === origin,
  );
  return cell ? `${cell.url}${requestUrl.pathname}${requestUrl.search}` : null;
}

export function cellCallbackRouter(
  directory: () => CellDirectory | null = () => cellDirectory(),
): MiddlewareHandler {
  return async (context, next) => {
    if (context.req.method !== "GET") return next();
    const target = cellCallbackRedirect(new URL(context.req.url), directory());
    if (!target) return next();
    console.info(JSON.stringify({ event: "cell_oauth_callback_forwarded", path: context.req.path }));
    return context.redirect(target, 302);
  };
}
