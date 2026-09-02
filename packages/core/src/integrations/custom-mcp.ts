import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { Readable } from "node:stream";
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
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch } from "undici";
import { z } from "zod";

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const IPV4_COMPATIBLE_IPV6_RANGE = ipaddr.parseCIDR("::/96");
const GLOBAL_UNICAST_IPV6_RANGE = ipaddr.parseCIDR("2000::/3");

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
    const publicOrigin = new URL("/", this.redirectUrl);
    return {
      client_name: "Responder",
      client_uri: publicOrigin.toString(),
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      logo_uri: new URL(
        "/superlog-wordmark.svg",
        publicOrigin,
      ).toString(),
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

function addressIsPublic(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  if (
    parsed.kind() === "ipv6" &&
    (parsed.match(IPV4_COMPATIBLE_IPV6_RANGE) ||
      !parsed.match(GLOBAL_UNICAST_IPV6_RANGE))
  ) {
    return false;
  }
  return parsed.range() === "unicast";
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
  options: { allowLocal?: boolean; signal?: AbortSignal } = {},
): Promise<URL> {
  return (await resolveCustomMcpUrl(input, options)).url;
}

interface ResolvedCustomMcpUrl {
  addresses: LookupAddress[];
  url: URL;
}

async function resolveCustomMcpUrl(
  input: string | URL,
  options: { allowLocal?: boolean; signal?: AbortSignal } = {},
): Promise<ResolvedCustomMcpUrl> {
  const url = new URL(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.username || url.password) {
    throw new Error("MCP URLs cannot contain credentials");
  }

  const localAllowed = options.allowLocal === true && localHostname(hostname);
  if (url.protocol !== "https:" && !(localAllowed && url.protocol === "http:")) {
    throw new Error("MCP URLs must use HTTPS");
  }

  if (localHostname(hostname)) {
    if (!localAllowed) throw new Error("MCP URLs must use a public host");
  }

  if (ipaddr.isValid(hostname)) {
    if (!localAllowed && !addressIsPublic(hostname)) {
      throw new Error("MCP URLs must use a public host");
    }
    return {
      addresses: [
        {
          address: hostname,
          family: ipaddr.parse(hostname).kind() === "ipv4" ? 4 : 6,
        },
      ],
      url,
    };
  }

  const lookupSignal = options.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    const aborted = () => {
      reject(lookupSignal.reason ?? new Error("MCP DNS lookup was aborted"));
    };
    if (lookupSignal.aborted) {
      aborted();
      return;
    }
    lookupSignal.addEventListener("abort", aborted, { once: true });
    void lookup(hostname, { all: true, verbatim: true }).then(
      (result) => {
        lookupSignal.removeEventListener("abort", aborted);
        resolve(result);
      },
      (error: unknown) => {
        lookupSignal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
  if (
    addresses.length === 0 ||
    (!localAllowed &&
      addresses.some(({ address }) => !addressIsPublic(address)))
  ) {
    throw new Error("MCP URLs must resolve only to public addresses");
  }
  return {
    addresses: addresses.map(({ address }) => ({
      address,
      family: ipaddr.parse(address).kind() === "ipv4" ? 4 : 6,
    })),
    url,
  };
}

function pinnedAddressAgent(target: ResolvedCustomMcpUrl): Agent {
  const expectedHostname = target.url.hostname.replace(/^\[|\]$/g, "");
  const approvedAddresses = [...target.addresses].sort(
    (left, right) => left.family - right.family,
  );
  if (approvedAddresses.length === 0) {
    throw new Error("MCP URLs must resolve only to public addresses");
  }

  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        const actualHostname = hostname.toLowerCase().replace(/\.$/, "");
        if (actualHostname !== expectedHostname.toLowerCase().replace(/\.$/, "")) {
          const error = new Error("MCP request hostname changed after validation");
          Object.assign(error, { code: "EAI_FAIL" });
          callback(error, "", 0);
          return;
        }
        if (options.all) {
          callback(null, approvedAddresses);
          return;
        }
        const requestedFamily = Number(options.family) || 0;
        const selectedAddress = requestedFamily
          ? approvedAddresses.find(({ family }) => family === requestedFamily)
          : approvedAddresses[0];
        if (!selectedAddress) {
          const error = new Error("No approved MCP address matches the requested family");
          Object.assign(error, { code: "EAI_ADDRFAMILY" });
          callback(error, "", 0);
          return;
        }
        callback(null, selectedAddress.address, selectedAddress.family);
      },
      // The socket connects to the pinned address, but TLS must authenticate the
      // hostname from the requested URL and send that hostname through SNI.
      ...(ipaddr.isValid(expectedHostname)
        ? {}
        : { servername: expectedHostname }),
    },
    maxResponseSize: MAX_RESPONSE_BYTES,
  });
}

async function fetchPinnedRequest(
  request: Request,
  dispatcher: Agent,
): Promise<Response> {
  const body = request.body
    ? Readable.fromWeb(request.body as import("node:stream/web").ReadableStream)
    : undefined;
  const headers = new Headers(request.headers);
  // Undici transparently decompresses response bodies. Ask the peer not to
  // compress, then still count decoded bytes below because an untrusted server
  // can ignore this request header.
  headers.set("accept-encoding", "identity");
  try {
    const response = await undiciFetch(request.url, {
      ...(body ? { body, duplex: "half" as const } : {}),
      dispatcher,
      headers,
      method: request.method,
      redirect: "manual",
      signal: request.signal,
    });
    let decodedBytes = 0;
    const responseBody = response.body as unknown as ReadableStream<Uint8Array> | null;
    const limitedBody = responseBody
      ? responseBody.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              decodedBytes += chunk.byteLength;
              if (decodedBytes > MAX_RESPONSE_BYTES) {
                const error = new Error(
                  `MCP response exceeds ${MAX_RESPONSE_BYTES} decoded bytes`,
                );
                void dispatcher.destroy(error).catch(() => undefined);
                controller.error(error);
                return;
              }
              controller.enqueue(chunk);
            },
          }),
        )
      : null;
    // Keep the public fetch contract (including `instanceof Response`) for the
    // MCP SDK while the underlying body remains attached to the pinned agent.
    // The agent-level limit bounds compressed wire bytes; this stream bounds
    // decoded bytes before JSON parsing or other buffering can amplify them.
    return new Response(limitedBody as ReadableStream | null, {
      headers: new Headers(response.headers as unknown as HeadersInit),
      status: response.status,
      statusText: response.statusText,
    });
  } catch (error) {
    await dispatcher.destroy(error instanceof Error ? error : null);
    throw error;
  }
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
    const target = await resolveCustomMcpUrl(request.url, {
      allowLocal: process.env.NODE_ENV !== "production",
      signal: request.signal,
    });
    const redirectRequest = request.clone();
    const dispatcher = pinnedAddressAgent(target);
    const response = await fetchPinnedRequest(request, dispatcher);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      void dispatcher.close().catch(() => undefined);
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      void dispatcher.close().catch(() => undefined);
      return response;
    }
    await response.body?.cancel();
    await dispatcher.close();
    if (redirects >= MAX_REDIRECTS) {
      throw new Error("MCP request redirected too many times");
    }
    redirects += 1;
    const nextUrl = new URL(location, request.url);
    if (nextUrl.origin !== new URL(request.url).origin) {
      throw new Error("MCP requests cannot redirect to another origin");
    }
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

export async function listCustomMcpTools(input: {
  accessToken: string;
  mcpUrl: string;
}): Promise<string[]> {
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
    return tools.tools.map((tool) => tool.name);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function verifyCustomMcpConnection(input: {
  accessToken: string;
  mcpUrl: string;
}): Promise<number> {
  return (await listCustomMcpTools(input)).length;
}
