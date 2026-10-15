import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { performance } from "node:perf_hooks";
import type { TLSSocket } from "node:tls";
import zlib from "node:zlib";
import { addressIsPublic, localHostname } from "../network/public-address.js";
import { evaluateSyntheticAssertions, syntheticRunStatus } from "./assertions.js";
import {
  emptyTimings,
  type SyntheticAssertion,
  type SyntheticRequest,
  type SyntheticResponse,
  type SyntheticRunResult,
  type SyntheticTimings,
} from "./types.js";

// Decoded body bytes read for assertions. A longer body is cut off there.
const maxBodyBytes = 1024 * 1024;
const maxRedirects = 5;
const userAgent = "Superlog-Synthetics/1.0 (+https://superlog.sh)";
// Not sent to another origin after a redirect.
const credentialHeaders = new Set(["authorization", "cookie", "proxy-authorization"]);

export class SyntheticRequestError extends Error {
  constructor(
    message: string,
    readonly timings: SyntheticTimings,
  ) {
    super(message);
    this.name = "SyntheticRequestError";
  }
}

export interface SyntheticRunnerOptions {
  // Lets checks reach loopback and .localhost names, for local development.
  allowLocal?: boolean;
  // Resolves a hostname to every address. Replaced in tests.
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  signal?: AbortSignal;
}

interface Hop {
  body: Buffer;
  bodyBytes: number;
  bodyTruncated: boolean;
  certificateExpiresAt: string | null;
  headers: Record<string, string>;
  statusCode: number;
  timings: SyntheticTimings;
}

function addTimings(a: SyntheticTimings, b: SyntheticTimings): SyntheticTimings {
  return {
    connectMs: a.connectMs + b.connectMs,
    dnsMs: a.dnsMs + b.dnsMs,
    downloadMs: a.downloadMs + b.downloadMs,
    firstByteMs: a.firstByteMs + b.firstByteMs,
    tlsMs: a.tlsMs + b.tlsMs,
  };
}

function rounded(timings: SyntheticTimings): SyntheticTimings {
  const round = (value: number) => Math.max(0, Math.round(value * 10) / 10);
  return {
    connectMs: round(timings.connectMs),
    dnsMs: round(timings.dnsMs),
    downloadMs: round(timings.downloadMs),
    firstByteMs: round(timings.firstByteMs),
    tlsMs: round(timings.tlsMs),
  };
}

async function defaultResolve(hostname: string): Promise<LookupAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

// Every address of the host, each one public unless local hosts are
// allowed. The request connects only to these, so a second lookup cannot
// point it elsewhere.
async function publicAddresses(
  hostname: string,
  options: SyntheticRunnerOptions,
  signal: AbortSignal,
): Promise<LookupAddress[]> {
  const local = options.allowLocal === true && localHostname(hostname);
  if (localHostname(hostname) && !local) throw new Error("The URL must use a public host");
  if (isIP(hostname)) {
    if (!local && !addressIsPublic(hostname)) throw new Error("The URL must use a public host");
    return [{ address: hostname, family: isIP(hostname) }];
  }
  let addresses: LookupAddress[];
  try {
    addresses = await Promise.race([(options.resolve ?? defaultResolve)(hostname), aborted(signal)]);
  } catch (error) {
    if (signal.aborted) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(code === "ENOTFOUND" || code === "ENODATA" ? `Could not resolve ${hostname}` : `DNS lookup failed: ${String((error as Error).message)}`);
  }
  if (addresses.length === 0) throw new Error(`Could not resolve ${hostname}`);
  if (!local && addresses.some(({ address }) => !addressIsPublic(address))) {
    throw new Error("The host must resolve only to public addresses");
  }
  return addresses;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function pinnedLookup(addresses: LookupAddress[]) {
  const ordered = [...addresses].sort((left, right) => left.family - right.family);
  return (_hostname: string, options: { all?: boolean; family?: number | string }, callback: LookupCallback) => {
    if (options.all) {
      callback(null, ordered);
      return;
    }
    const family = Number(options.family) || 0;
    const selected = family ? ordered.find((address) => address.family === family) : ordered[0];
    if (!selected) {
      callback(Object.assign(new Error("No resolved address matches the requested family"), { code: "EAI_ADDRFAMILY" }), "", 0);
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

function responseHeaders(message: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

function decoder(encoding: string | undefined): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  switch (encoding?.trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

const errorMessages: Record<string, string> = {
  CERT_HAS_EXPIRED: "The TLS certificate has expired",
  DEPTH_ZERO_SELF_SIGNED_CERT: "The TLS certificate is self-signed",
  ECONNREFUSED: "The connection was refused",
  ECONNRESET: "The connection was reset",
  EHOSTUNREACH: "The host is unreachable",
  ENETUNREACH: "The network is unreachable",
  EPROTO: "The TLS handshake failed",
  ERR_TLS_CERT_ALTNAME_INVALID: "The TLS certificate does not match the host",
  SELF_SIGNED_CERT_IN_CHAIN: "The TLS certificate chain is self-signed",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "The TLS certificate could not be verified",
};

function requestErrorMessage(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code && errorMessages[code]) return errorMessages[code];
  return error instanceof Error ? error.message : String(error);
}

function certificateExpiry(socket: TLSSocket): string | null {
  const validTo = socket.getPeerCertificate?.()?.valid_to;
  const time = validTo ? Date.parse(validTo) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

// One request without following redirects.
async function requestOnce(
  url: URL,
  init: { body: string | null; headers: Record<string, string>; method: string },
  options: SyntheticRunnerOptions,
  signal: AbortSignal,
): Promise<Hop> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const dnsStart = performance.now();
  const addresses = await publicAddresses(hostname, options, signal).catch((error: unknown) => {
    throw new SyntheticRequestError(signal.aborted ? "Timed out" : requestErrorMessage(error), {
      ...emptyTimings,
      dnsMs: performance.now() - dnsStart,
    });
  });
  const dnsMs = performance.now() - dnsStart;
  const secure = url.protocol === "https:";

  return new Promise<Hop>((resolve, reject) => {
    const start = performance.now();
    let connectedAt: number | null = null;
    let securedAt: number | null = null;
    let firstByteAt: number | null = null;
    let certificateExpiresAt: string | null = null;
    let settled = false;
    // Stops a decompression stream, which would otherwise keep decoding what
    // it has buffered after the run ends.
    let stopDecoding = () => {};
    const timings = (end = performance.now()): SyntheticTimings => {
      const connected = connectedAt ?? end;
      const secured = secure ? (securedAt ?? (connectedAt === null ? connected : end)) : connected;
      const firstByte = firstByteAt ?? (connectedAt === null ? secured : end);
      return {
        connectMs: connected - start,
        dnsMs,
        downloadMs: firstByteAt === null ? 0 : end - firstByteAt,
        firstByteMs: firstByte - secured,
        tlsMs: secured - connected,
      };
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      stopDecoding();
      request.destroy();
      reject(new SyntheticRequestError(signal.aborted ? "Timed out" : requestErrorMessage(error), timings()));
    };

    const requestOptions: https.RequestOptions = {
      agent: false,
      headers: init.headers,
      hostname,
      lookup: pinnedLookup(addresses) as unknown as https.RequestOptions["lookup"],
      method: init.method,
      path: `${url.pathname}${url.search}`,
      port: url.port || (secure ? 443 : 80),
      signal,
      ...(secure && !isIP(hostname) ? { servername: hostname } : {}),
    };
    const request = (secure ? https : http).request(requestOptions, (response) => {
      firstByteAt = performance.now();
      const chunks: Buffer[] = [];
      let bodyBytes = 0;
      let bodyTruncated = false;
      // Responses that cannot have a body may still name an encoding.
      const bodiless = init.method === "HEAD" || response.statusCode === 204 || response.statusCode === 304;
      const decode = bodiless ? null : decoder(response.headers["content-encoding"]);
      const body = decode ? response.pipe(decode) : response;
      if (decode) {
        stopDecoding = () => {
          response.unpipe(decode);
          decode.destroy();
        };
      }
      // Encoded bytes received, so an empty encoded body reads as empty
      // rather than as a decoding error.
      let encodedBytes = 0;
      if (decode) response.on("data", (chunk: Buffer) => (encodedBytes += chunk.byteLength));
      const finish = () => {
        if (settled) return;
        settled = true;
        const end = performance.now();
        stopDecoding();
        request.destroy();
        resolve({
          body: Buffer.concat(chunks),
          bodyBytes,
          bodyTruncated,
          certificateExpiresAt,
          headers: responseHeaders(response),
          statusCode: response.statusCode ?? 0,
          timings: timings(end),
        });
      };
      body.on("data", (chunk: Buffer) => {
        if (settled) return;
        const room = maxBodyBytes - bodyBytes;
        if (chunk.byteLength > room) {
          chunks.push(chunk.subarray(0, room));
          bodyBytes += room;
          bodyTruncated = true;
          finish();
          return;
        }
        chunks.push(chunk);
        bodyBytes += chunk.byteLength;
      });
      body.on("end", finish);
      body.on("error", (error: Error) => {
        if (decode && encodedBytes === 0) finish();
        else fail(decode ? new Error("The response body could not be decoded") : error);
      });
      response.on("error", fail);
    });
    request.on("socket", (socket) => {
      socket.once("connect", () => {
        connectedAt = performance.now();
      });
      socket.once("secureConnect", () => {
        securedAt = performance.now();
        certificateExpiresAt = certificateExpiry(socket as TLSSocket);
      });
    });
    request.on("error", fail);
    request.end(init.body ?? undefined);
  });
}

function redirected(statusCode: number): boolean {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

export interface SyntheticExecution {
  durationMs: number;
  response: SyntheticResponse & { fullBody: string };
  timings: SyntheticTimings;
}

// Makes the request, following redirects when asked. Throws a
// SyntheticRequestError, with the time spent, when no response arrives.
export async function executeSyntheticRequest(
  request: SyntheticRequest,
  options: SyntheticRunnerOptions = {},
  previewBytes = 4_096,
): Promise<SyntheticExecution> {
  const signal = AbortSignal.any([AbortSignal.timeout(request.timeoutMs), ...(options.signal ? [options.signal] : [])]);
  const start = performance.now();
  let url = new URL(request.url);
  let method: string = request.method;
  let body = request.body;
  const headers: Record<string, string> = {
    "accept-encoding": "gzip, deflate, br",
    "user-agent": userAgent,
  };
  for (const header of request.headers) headers[header.name.toLowerCase()] = header.value;
  const secretNames = new Set(request.headers.filter((header) => header.secret).map((header) => header.name.toLowerCase()));
  let timings = emptyTimings;
  let redirects = 0;

  try {
    while (true) {
      const hop = await requestOnce(url, { body, headers, method }, options, signal);
      timings = addTimings(timings, hop.timings);
      const location = hop.headers.location;
      if (!request.followRedirects || !redirected(hop.statusCode) || !location || redirects >= maxRedirects) {
        if (request.followRedirects && redirected(hop.statusCode) && location && redirects >= maxRedirects) {
          throw new SyntheticRequestError(`Redirected more than ${maxRedirects} times`, timings);
        }
        const text = hop.body.toString("utf8");
        return {
          durationMs: performance.now() - start,
          response: {
            body: text.slice(0, previewBytes),
            bodyBytes: hop.bodyBytes,
            bodyTruncated: hop.bodyTruncated,
            certificateExpiresAt: hop.certificateExpiresAt,
            fullBody: text,
            headers: hop.headers,
            redirects,
            statusCode: hop.statusCode,
            url: url.toString(),
          },
          timings: rounded(timings),
        };
      }
      const next = new URL(location, url);
      if (next.protocol !== "https:" && next.protocol !== "http:") {
        throw new SyntheticRequestError("Redirected to a URL that is not HTTP", timings);
      }
      if (next.origin !== url.origin) {
        for (const name of Object.keys(headers)) {
          if (credentialHeaders.has(name) || secretNames.has(name)) delete headers[name];
        }
      }
      if (hop.statusCode === 303 || ((hop.statusCode === 301 || hop.statusCode === 302) && method === "POST")) {
        method = method === "HEAD" ? "HEAD" : "GET";
        body = null;
        delete headers["content-type"];
      }
      url = next;
      redirects += 1;
    }
  } catch (error) {
    if (error instanceof SyntheticRequestError) {
      throw new SyntheticRequestError(
        error.message === "Timed out" ? `Timed out after ${request.timeoutMs} ms` : error.message,
        rounded(error.timings),
      );
    }
    throw error;
  }
}

// One attempt: the request and its assertions.
export async function runSyntheticAttempt(
  request: SyntheticRequest,
  assertions: readonly SyntheticAssertion[],
  options: SyntheticRunnerOptions & { now?: () => Date; previewBytes?: number } = {},
): Promise<Omit<SyntheticRunResult, "attempts">> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const start = performance.now();
  try {
    const execution = await executeSyntheticRequest(request, options, options.previewBytes);
    const { fullBody, ...response } = execution.response;
    const results = evaluateSyntheticAssertions(assertions, { ...response, body: fullBody }, execution.durationMs, now());
    return {
      assertions: results,
      durationMs: Math.round(execution.durationMs * 10) / 10,
      error: null,
      response,
      startedAt: startedAt.toISOString(),
      status: syntheticRunStatus(null, results),
      timings: execution.timings,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      assertions: evaluateSyntheticAssertions(assertions, null, 0, now()),
      durationMs: Math.round((performance.now() - start) * 10) / 10,
      error: message.slice(0, 500),
      response: null,
      startedAt: startedAt.toISOString(),
      status: "failed",
      timings: error instanceof SyntheticRequestError ? error.timings : emptyTimings,
    };
  }
}

// Runs the check, retrying a failed attempt up to `retries` times. The last
// attempt is the result.
export async function runSyntheticCheck(
  check: { assertions: readonly SyntheticAssertion[]; request: SyntheticRequest; retries: number },
  options: SyntheticRunnerOptions & { now?: () => Date; previewBytes?: number; retryDelayMs?: number } = {},
): Promise<SyntheticRunResult> {
  let attempts = 0;
  while (true) {
    attempts += 1;
    const result = await runSyntheticAttempt(check.request, check.assertions, options);
    if (result.status !== "failed" || attempts > check.retries || options.signal?.aborted) return { ...result, attempts };
    await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 1_000));
  }
}
