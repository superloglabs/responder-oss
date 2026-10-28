import type { MiddlewareHandler } from "hono";
import { z } from "zod";

// Answers 404 when a route's ID parameter is not a UUID, before it reaches a
// uuid column. Register it after the router's fixed paths: a request for a
// fixed path with a method it lacks (GET /secrets when only POST exists)
// falls through to the parameter routes and stops here.
export function requireUuidParam(
  name: string,
  notFound: string,
): MiddlewareHandler {
  return async function requireUuidParam(context, next) {
    if (!z.uuid().safeParse(context.req.param(name)).success) {
      return context.json({ error: notFound }, 404);
    }
    await next();
  };
}
