import { Hono, type Context } from "hono";
import {
  authenticateManagementRequest,
  executeOperation,
  isPlainObject,
  unauthorizedBody,
} from "./execute.js";
import { buildOpenApiDocument } from "./openapi.js";
import { pathParameterNames, type ManagementOperation } from "./operation.js";
import { managementOperations } from "./operations.js";

function appOrigin(requestUrl: string): string {
  const configured = process.env.BETTER_AUTH_URL;
  return configured ? new URL(configured).origin : new URL(requestUrl).origin;
}

async function requestInput(
  context: Context,
  operation: ManagementOperation,
): Promise<{ ok: true; input: Record<string, unknown> } | { ok: false }> {
  const path = Object.fromEntries(
    pathParameterNames(operation.path).map((name) => [name, context.req.param(name)]),
  );
  if (operation.method === "GET" || operation.method === "DELETE") {
    return { input: { ...context.req.query(), ...path }, ok: true };
  }
  const text = await context.req.text();
  if (!text.trim()) return { input: path, ok: true };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (!isPlainObject(body)) return { ok: false };
  return { input: { ...body, ...path }, ok: true };
}

function honoPath(path: string): string {
  return path.replace(/\{([A-Za-z]+)\}/gu, ":$1");
}

const routes = new Hono()
  .use("*", async (context, next) => {
    await next();
    context.header("Cache-Control", "no-store");
  })
  .get("/openapi.json", (context) =>
    context.json(
      buildOpenApiDocument(managementOperations, appOrigin(context.req.url)),
    ),
  );

for (const operation of managementOperations) {
  routes.on(operation.method, honoPath(operation.path), async (context) => {
    const caller = await authenticateManagementRequest(context.req.raw.headers, "api");
    if (!caller) {
      context.header("WWW-Authenticate", 'Bearer realm="superlog"');
      return context.json(unauthorizedBody, 401);
    }
    const input = await requestInput(context, operation);
    if (!input.ok) {
      return context.json(
        { code: "invalid_request", error: "The request body must be a JSON object." },
        400,
      );
    }
    const result = await executeOperation(operation, caller, input.input);
    return context.json(result.body, result.status as 200);
  });
}

routes.all("*", (context) =>
  context.json({ code: "not_found", error: "Not found" }, 404),
);

// The REST management API, served under /api/v1.
export const managementApiRoutes = routes;
