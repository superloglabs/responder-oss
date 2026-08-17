import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;

export interface StoredCustomMcpOAuthState {
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  tokens?: OAuthTokens;
}

export type CustomMcpCredentials =
  | {
      apiToken: string;
      authType: "api_token";
      mcpUrl: string;
    }
  | {
      authType: "oauth";
      mcpUrl: string;
      oauth: StoredCustomMcpOAuthState;
    };

const customMcpCredentialsSchema = z.discriminatedUnion("authType", [
  z.object({
    apiToken: z.string().min(1),
    authType: z.literal("api_token"),
    mcpUrl: z.string().url(),
  }),
  z.object({
    authType: z.literal("oauth"),
    mcpUrl: z.string().url(),
    oauth: z.object({
      clientInformation: z.record(z.string(), z.unknown()).optional(),
      codeVerifier: z.string().min(1).optional(),
      discoveryState: z.record(z.string(), z.unknown()).optional(),
      tokens: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
]);

export function parseCustomMcpCredentials(
  input: unknown,
): CustomMcpCredentials {
  return customMcpCredentialsSchema.parse(input) as CustomMcpCredentials;
}

export class CustomMcpOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL;

  constructor(
    private readonly options: {
      connectionState?: string;
      redirectUrl: string;
      stored?: StoredCustomMcpOAuthState;
    },
  ) {}

  get redirectUrl(): string {
    return this.options.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Responder",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.options.connectionState ?? "responder-runtime-refresh";
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.options.stored?.clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.storage().clientInformation = clientInformation;
  }

  tokens(): OAuthTokens | undefined {
    return this.options.stored?.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.storage().tokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = authorizationUrl;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.storage().codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    const verifier = this.options.stored?.codeVerifier;
    if (!verifier) throw new Error("The MCP OAuth verifier is missing");
    return verifier;
  }

  saveDiscoveryState(discoveryState: OAuthDiscoveryState): void {
    this.storage().discoveryState = discoveryState;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.options.stored?.discoveryState;
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void {
    const stored = this.storage();
    if (scope === "all" || scope === "client") delete stored.clientInformation;
    if (scope === "all" || scope === "tokens") delete stored.tokens;
    if (scope === "all" || scope === "verifier") delete stored.codeVerifier;
    if (scope === "all" || scope === "discovery") delete stored.discoveryState;
  }

  snapshot(): StoredCustomMcpOAuthState {
    return { ...this.storage() };
  }

  private storage(): StoredCustomMcpOAuthState {
    this.options.stored ??= {};
    return this.options.stored;
  }
}

function ipv4IsPublic(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return false;
  }
  const [a, b, c] = octets as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function addressIsPublic(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return ipv4IsPublic(address);
  if (family !== 6) return false;

  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return ipv4IsPublic(normalized.slice("::ffff:".length));
  }
  return !(
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("2001:db8:")
  );
}

function localHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  );
}

export async function validateCustomMcpUrl(
  input: string | URL,
  options: { allowLocal?: boolean } = {},
): Promise<URL> {
  const url = input instanceof URL ? new URL(input) : new URL(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.username || url.password) {
    throw new Error("MCP URLs cannot contain credentials");
  }

  const localAllowed = options.allowLocal === true && localHostname(hostname);
  if (url.protocol !== "https:" && !(localAllowed && url.protocol === "http:")) {
    throw new Error("MCP URLs must use HTTPS");
  }

  if (localAllowed) return url;
  if (localHostname(hostname)) {
    throw new Error("MCP URLs must use a public host");
  }

  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!addressIsPublic(hostname)) {
      throw new Error("MCP URLs must use a public host");
    }
    return url;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !addressIsPublic(address))) {
    throw new Error("MCP URLs must resolve only to public addresses");
  }
  return url;
}

export async function safeCustomMcpFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const initialRequest = new Request(input, init);
  let request = new Request(initialRequest, {
    signal: AbortSignal.any([
      initialRequest.signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ]),
  });
  let redirects = 0;
  while (true) {
    await validateCustomMcpUrl(request.url, {
      allowLocal: process.env.NODE_ENV !== "production",
    });
    const redirectRequest = request.clone();
    const response = await fetch(request, { redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get("location");
    if (!location) return response;
    if (redirects >= MAX_REDIRECTS) {
      throw new Error("MCP request redirected too many times");
    }
    redirects += 1;
    const nextUrl = new URL(location, request.url);
    const switchToGet =
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && request.method === "POST");
    const redirectedRequest = switchToGet
      ? new Request(nextUrl, {
          headers: redirectRequest.headers,
          method: "GET",
          signal: redirectRequest.signal,
        })
      : new Request(nextUrl, redirectRequest);
    if (nextUrl.origin !== new URL(request.url).origin) {
      redirectedRequest.headers.delete("authorization");
      redirectedRequest.headers.delete("cookie");
      redirectedRequest.headers.delete("proxy-authorization");
    }
    request = redirectedRequest;
  }
}

export async function beginCustomMcpOAuth(input: {
  connectionState: string;
  mcpUrl: string;
  redirectUrl: string;
}): Promise<{
  authorizationUrl: string;
  oauth: StoredCustomMcpOAuthState;
}> {
  const mcpUrl = await validateCustomMcpUrl(input.mcpUrl, {
    allowLocal: process.env.NODE_ENV !== "production",
  });
  const provider = new CustomMcpOAuthProvider({
    connectionState: input.connectionState,
    redirectUrl: input.redirectUrl,
  });
  const result = await auth(provider, {
    fetchFn: safeCustomMcpFetch,
    serverUrl: mcpUrl,
  });
  if (result !== "REDIRECT" || !provider.authorizationUrl) {
    throw new Error("The MCP server did not start an OAuth authorization flow");
  }
  const authorizationUrl = await validateCustomMcpUrl(provider.authorizationUrl, {
    allowLocal: process.env.NODE_ENV !== "production",
  });
  return {
    authorizationUrl: authorizationUrl.toString(),
    oauth: provider.snapshot(),
  };
}

export async function finishCustomMcpOAuth(input: {
  authorizationCode: string;
  mcpUrl: string;
  oauth: StoredCustomMcpOAuthState;
  redirectUrl: string;
}): Promise<StoredCustomMcpOAuthState> {
  const provider = new CustomMcpOAuthProvider({
    redirectUrl: input.redirectUrl,
    stored: input.oauth,
  });
  const result = await auth(provider, {
    authorizationCode: input.authorizationCode,
    fetchFn: safeCustomMcpFetch,
    serverUrl: input.mcpUrl,
  });
  if (result !== "AUTHORIZED" || !provider.snapshot().tokens?.access_token) {
    throw new Error("The MCP server did not return an access token");
  }
  return provider.snapshot();
}

export async function refreshCustomMcpOAuth(input: {
  mcpUrl: string;
  oauth: StoredCustomMcpOAuthState;
  redirectUrl: string;
}): Promise<StoredCustomMcpOAuthState> {
  if (!input.oauth.tokens?.refresh_token) return input.oauth;
  const provider = new CustomMcpOAuthProvider({
    redirectUrl: input.redirectUrl,
    stored: input.oauth,
  });
  const result = await auth(provider, {
    fetchFn: safeCustomMcpFetch,
    serverUrl: input.mcpUrl,
  });
  if (result !== "AUTHORIZED" || !provider.snapshot().tokens?.access_token) {
    throw new Error("Reconnect the custom MCP OAuth connection");
  }
  return provider.snapshot();
}

export async function verifyCustomMcpConnection(input: {
  accessToken: string;
  mcpUrl: string;
}): Promise<number> {
  const url = await validateCustomMcpUrl(input.mcpUrl, {
    allowLocal: process.env.NODE_ENV !== "production",
  });
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: safeCustomMcpFetch,
    requestInit: {
      headers: { authorization: `Bearer ${input.accessToken}` },
    },
  });
  const client = new Client({ name: "responder-connection-check", version: "1" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    return tools.tools.length;
  } finally {
    await client.close().catch(() => undefined);
  }
}
