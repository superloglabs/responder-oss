import type { MiddlewareHandler } from "hono";
import { getActiveTenant } from "./tenant.js";

// A deployment can run one extension: a separate service, reachable only
// from the control plane, that serves its own API under a path prefix and
// handles its own Slack buttons. The control plane signs people in and
// forwards their requests with the member and workspace in headers, so the
// extension never reads session cookies.
export interface ExtensionConfig {
  // The extension's base URL on the private network.
  url: string;
  // Sent as a bearer token on every forwarded request.
  token: string;
  // Requests under this path are forwarded, such as `/api/example`.
  pathPrefix: string;
  // Slack block actions whose action ID starts with this are forwarded to
  // `<pathPrefix>/internal/slack-interactions`.
  slackActionPrefix: string | null;
}

export const extensionUserHeader = "x-responder-user-id";
export const extensionOrganizationHeader = "x-responder-organization-id";
export const extensionRoleHeader = "x-responder-member-role";

const forwardedRequestHeaders = ["accept", "content-type", "user-agent"];
const forwardedResponseHeaders = ["cache-control", "content-type"];
const requestTimeoutMs = 30_000;

export function extensionConfig(environment: NodeJS.ProcessEnv = process.env): ExtensionConfig | null {
  const url = environment.RESPONDER_EXTENSION_URL?.trim();
  const token = environment.RESPONDER_EXTENSION_TOKEN?.trim();
  const pathPrefix = environment.RESPONDER_EXTENSION_PATH_PREFIX?.trim().replace(/\/+$/u, "");
  if (!url || !token || !pathPrefix) return null;
  // An invalid setting turns the extension off rather than failing requests.
  if (!/^\/api\/[a-z0-9-]+$/u.test(pathPrefix) || !/^https?:\/\/[^/]+/u.test(url)) {
    console.error(JSON.stringify({ event: "extension_config_invalid" }));
    return null;
  }
  return {
    url: url.replace(/\/+$/u, ""),
    token,
    pathPrefix,
    slackActionPrefix: environment.RESPONDER_EXTENSION_SLACK_ACTION_PREFIX?.trim() || null,
  };
}

export function isExtensionPath(path: string, config: ExtensionConfig): boolean {
  return path === config.pathPrefix || path.startsWith(`${config.pathPrefix}/`);
}

export interface ExtensionProxyDependencies {
  config: () => ExtensionConfig | null;
  tenant: (headers: Headers) => ReturnType<typeof getActiveTenant>;
  fetch: typeof fetch;
}

const defaultDependencies: ExtensionProxyDependencies = {
  config: extensionConfig,
  tenant: getActiveTenant,
  fetch: (input, init) => fetch(input, init),
};

// Forwards requests under the extension's prefix. The member and workspace
// are added only for a signed-in member of the active workspace; headers of
// the same names sent by the browser are never forwarded.
export function extensionProxy(
  dependencies: ExtensionProxyDependencies = defaultDependencies,
): MiddlewareHandler {
  return async function extensionProxyRequest(context, next) {
    const config = dependencies.config();
    if (!config || !isExtensionPath(context.req.path, config)) return next();
    // Its internal routes are reached only from inside the deployment.
    if (context.req.path.startsWith(`${config.pathPrefix}/internal/`)) {
      return context.json({ error: "Not found" }, 404);
    }

    const headers = new Headers({ authorization: `Bearer ${config.token}` });
    for (const name of forwardedRequestHeaders) {
      const value = context.req.header(name);
      if (value) headers.set(name, value);
    }
    const tenant = await dependencies.tenant(context.req.raw.headers);
    if (tenant.ok) {
      headers.set(extensionUserHeader, tenant.user.id);
      headers.set(extensionOrganizationHeader, tenant.organizationId);
      headers.set(extensionRoleHeader, tenant.role);
    }

    const url = new URL(context.req.url);
    const method = context.req.method;
    try {
      const response = await dependencies.fetch(`${config.url}${url.pathname}${url.search}`, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : await context.req.arrayBuffer(),
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const responseHeaders = new Headers();
      for (const name of forwardedResponseHeaders) {
        const value = response.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }
      return new Response(response.body, { status: response.status, headers: responseHeaders });
    } catch (error) {
      console.error(JSON.stringify({
        event: "extension_request_failed",
        errorName: error instanceof Error ? error.name : typeof error,
        path: context.req.path,
      }));
      return context.json({ error: "This service is unavailable. Try again shortly." }, 502);
    }
  };
}

// Whether a verified Slack block action belongs to the extension.
export function isExtensionSlackAction(
  actions: ReadonlyArray<{ action_id: string }>,
  config: ExtensionConfig | null,
): config is ExtensionConfig & { slackActionPrefix: string } {
  const prefix = config?.slackActionPrefix;
  return Boolean(prefix) && actions.some((action) => action.action_id.startsWith(prefix!));
}

// Hands a verified Slack block action payload to the extension. Slack needs
// an answer within three seconds, so the caller acknowledges it first and
// the extension answers through the payload's response URL.
export async function forwardExtensionSlackAction(
  payload: unknown,
  config: ExtensionConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${config.url}${config.pathPrefix}/internal/slack-interactions`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "manual",
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) throw new Error(`The extension answered ${response.status}`);
}
