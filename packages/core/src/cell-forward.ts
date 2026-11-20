import { Agent, fetch as undiciFetch } from "undici";

// Each request to another cell opens its own connection. A pooled keep-alive
// connection can be closed by the other cell's edge while it sits idle, and a
// request sent on it then fails with a reset. A webhook cannot be sent again
// after that, because the other cell may already have handled it.
const freshConnections = new Agent({ pipelining: 0 });

export async function fetchOnFreshConnection(url: string, init: RequestInit): Promise<Response> {
  const response = await undiciFetch(url, {
    body: init.body as Uint8Array<ArrayBuffer> | null | undefined,
    dispatcher: freshConnections,
    headers: init.headers as Record<string, string> | Headers | undefined,
    method: init.method,
    signal: init.signal,
  });
  return response as unknown as Response;
}
