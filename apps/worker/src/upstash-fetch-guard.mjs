/* global AbortSignal, Request, Response */

import process from "node:process";
import { ReadableStream } from "node:stream/web";
import { URL } from "node:url";

const DEFAULT_MAXIMUM_RESPONSE_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 30_000;
const RESPONSE_LIMIT_ERROR =
  "Upstash response exceeded the 1 MiB investigation limit; narrow the query";
const TIMEOUT_ERROR = "Upstash request exceeded the investigation timeout";
const READONLY_PROBE_URL =
  "https://api.upstash.com/v2/redis/database/readonly-check-nonexistent";

function requestUrl(input) {
  if (input instanceof Request) return new URL(input.url);
  if (input instanceof URL) return input;
  return new URL(input);
}

function requestMethod(input, init) {
  return (init?.method ?? (input instanceof Request ? input.method : "GET"))
    .toUpperCase();
}

function validateUpstashRequest(url, method) {
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  ) {
    throw new Error("The Upstash child attempted an invalid request URL");
  }
  if (url.hostname === "api.upstash.com") {
    if (method !== "GET") {
      throw new Error("The Upstash child attempted a management API mutation");
    }
    return;
  }
  if (!url.hostname.endsWith(".upstash.io")) {
    throw new Error("The Upstash child attempted an unexpected request origin");
  }
  if (method !== "GET" && method !== "POST") {
    throw new Error("The Upstash child attempted an unsupported request method");
  }
}

async function boundedResponse(
  response,
  maximumResponseBytes,
  timeoutSignal,
  existingSignal,
) {
  if (!response.body) return response;

  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumResponseBytes
  ) {
    await response.body.cancel();
    throw new Error(RESPONSE_LIMIT_ERROR);
  }

  const reader = response.body.getReader();
  let receivedBytes = 0;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          return;
        }
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > maximumResponseBytes) {
          await reader.cancel();
          controller.error(new Error(RESPONSE_LIMIT_ERROR));
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(
          timeoutSignal.aborted && !existingSignal?.aborted
            ? new Error(TIMEOUT_ERROR)
            : error,
        );
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function createBoundedUpstashFetch(
  fetchImplementation = globalThis.fetch,
  maximumResponseBytes = DEFAULT_MAXIMUM_RESPONSE_BYTES,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
) {
  if (
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 1
  ) {
    throw new Error("The Upstash response limit is invalid");
  }
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) {
    throw new Error("The Upstash request timeout is invalid");
  }

  return async function guardedUpstashFetch(input, init) {
    const url = requestUrl(input);
    const method = requestMethod(input, init);

    // The upstream server probes write access with DELETE and only selects the
    // provider's read-only Redis/QStash tokens after receiving this response.
    // Answer locally so startup never performs a mutation-shaped request.
    if (url.href === READONLY_PROBE_URL && method === "DELETE") {
      return new Response("Readonly API key", {
        status: 403,
        statusText: "Forbidden",
      });
    }

    validateUpstashRequest(url, method);
    const existingSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
    let response;
    try {
      response = await fetchImplementation(input, {
        ...init,
        redirect: "error",
        signal: existingSignal
          ? AbortSignal.any([existingSignal, timeoutSignal])
          : timeoutSignal,
      });
    } catch (error) {
      if (timeoutSignal.aborted && !existingSignal?.aborted) {
        throw new Error(TIMEOUT_ERROR);
      }
      throw error;
    }
    return boundedResponse(
      response,
      maximumResponseBytes,
      timeoutSignal,
      existingSignal,
    );
  };
}

if (process.env.RESPONDER_UPSTASH_FETCH_GUARD === "1") {
  globalThis.fetch = createBoundedUpstashFetch();
}
