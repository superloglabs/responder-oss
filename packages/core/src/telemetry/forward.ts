// Sends OTLP over HTTP to this cell's collector for one workspace. The
// collector writes the x-superlog-project-id header onto every resource.
export async function forwardToCollector(
  input: {
    body: string;
    collectorUrl: string;
    contentEncoding?: string;
    contentType: "application/json" | "application/x-protobuf";
    organizationId: string;
    signal: "logs" | "metrics" | "traces";
  },
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const headers = new Headers({ "content-type": input.contentType, "x-superlog-project-id": input.organizationId });
  if (input.contentEncoding) headers.set("content-encoding", input.contentEncoding);
  return fetchImpl(`${input.collectorUrl}/v1/${input.signal}`, {
    body: input.body,
    headers,
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
}
