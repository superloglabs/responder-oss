import { describe, expect, it, vi } from "vitest";
import type { RenderFetch, RenderLogLine } from "../../integrations/render.js";
import type { OtlpLogsRequest } from "./otlp-json.js";
import { advanceCursor, pullRenderAccount, renderRefusedKey, type RenderPullSource, sentBefore } from "./render-pull.js";

const now = new Date("2026-11-25T10:00:00Z");
// Reads stop 20 seconds behind the present.
const end = "2026-11-25T09:59:40.000Z";

type Service = { id: string; name: string; ownerId: string; region: string | null; suspended?: boolean };

const web: Service = { id: "srv-web", name: "web", ownerId: "tea-1", region: "oregon" };
const worker: Service = { id: "srv-worker", name: "worker", ownerId: "tea-1", region: "oregon" };
const eu: Service = { id: "srv-eu", name: "eu-api", ownerId: "tea-1", region: "frankfurt" };

function log(timestamp: string, message: string, resource = "srv-web", id: string | null = `${resource}:${timestamp}:${message}`): RenderLogLine {
  return {
    id,
    labels: [
      { name: "resource", value: resource },
      { name: "instance", value: `${resource}-1` },
      { name: "level", value: "info" },
      { name: "type", value: "app" },
    ],
    message,
    timestamp,
  };
}

// Lines at 10 ms apart from `start`.
function lines(count: number, start: string, resource = "srv-web"): RenderLogLine[] {
  return Array.from({ length: count }, (_, index) =>
    log(new Date(Date.parse(start) + index * 10).toISOString(), `${resource} line ${index}`, resource));
}

type LogQuery = { endTime: string; ownerId: string; resources: string[]; startTime: string };

// A Render API that answers the way Render's does: lists of services, and
// forward pages of at most `limit` lines in [startTime, endTime] whose next
// page starts at the last line returned, so pages share their edge.
function render(input: {
  logs?: RenderLogLine[];
  logFailures?: Record<number, { body: unknown; status: number }>;
  services?: Service[];
  servicesStatus?: number;
}) {
  const logQueries: LogQuery[] = [];
  const all = [...(input.logs ?? [])].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const fetchFn = vi.fn<RenderFetch>(async (url) => {
    const parsed = new URL(url);
    const query = parsed.searchParams;
    if (parsed.pathname === "/v1/services") {
      if (input.servicesStatus) return Response.json({ message: "nope" }, { status: input.servicesStatus });
      return Response.json((input.services ?? [])
        .filter((service) => service.ownerId === query.get("ownerId"))
        .map((service) => ({
          cursor: service.id,
          service: {
            id: service.id,
            name: service.name,
            ownerId: service.ownerId,
            serviceDetails: service.region ? { region: service.region } : {},
            suspended: service.suspended ? "suspended" : "not_suspended",
            type: "web_service",
          },
        })));
    }
    const call = logQueries.length;
    const logQuery = {
      endTime: query.get("endTime")!,
      ownerId: query.get("ownerId")!,
      resources: query.getAll("resource"),
      startTime: query.get("startTime")!,
    };
    logQueries.push(logQuery);
    const failure = input.logFailures?.[call];
    if (failure) return Response.json(failure.body, { status: failure.status });
    const limit = Number(query.get("limit"));
    const matching = all.filter((line) => {
      const resource = line.labels.find((label) => label.name === "resource")!.value;
      return logQuery.resources.includes(resource) &&
        Date.parse(line.timestamp) >= Date.parse(logQuery.startTime) &&
        Date.parse(line.timestamp) <= Date.parse(logQuery.endTime);
    });
    const page = matching.slice(0, limit);
    const hasMore = matching.length > limit;
    return Response.json({
      hasMore,
      logs: page,
      nextEndTime: hasMore ? logQuery.endTime : null,
      nextStartTime: hasMore ? page.at(-1)!.timestamp : null,
    });
  });
  return { fetch: fetchFn, logQueries };
}

function collector(accept = true) {
  const sent: string[] = [];
  const forward = vi.fn(async (payload: OtlpLogsRequest) => {
    if (!accept) return false;
    for (const resource of payload.resourceLogs) {
      for (const record of resource.scopeLogs[0]!.logRecords) sent.push(String(Object.values(record.body)[0]));
    }
    return true;
  });
  return { forward, sent };
}

function workspaceSource(state: Record<string, unknown> = {}): RenderPullSource {
  return { externalId: "tea-1", id: "source-workspace", state: { kind: "workspace", ownerId: "tea-1", workspaceName: "Example Team", ...state } };
}

function serviceSource(service: Service, state: Record<string, unknown> = {}): RenderPullSource {
  return { externalId: service.id, id: `source-${service.id}`, state: { kind: "service", ownerId: service.ownerId, ...state } };
}

describe("pullRenderAccount", () => {
  it("starts a new workspace five minutes back and moves each service's cursor to the end of the window", async () => {
    const api = render({
      logs: [log("2026-11-25T09:54:00Z", "too old"), log("2026-11-25T09:58:00Z", "web ready"), log("2026-11-25T09:58:01Z", "job done", "srv-worker")],
      services: [web, worker],
    });
    const ingest = collector();

    const result = await pullRenderAccount({ apiKey: "key", fetch: api.fetch, forward: ingest.forward, now, sources: [workspaceSource()] });

    expect(ingest.sent).toEqual(["web ready", "job done"]);
    expect(api.logQueries).toEqual([{ endTime: end, ownerId: "tea-1", resources: ["srv-web", "srv-worker"], startTime: "2026-11-25T09:55:00.000Z" }]);
    const source = result.sources.get("source-workspace")!;
    expect(source).toMatchObject({ error: null, logs: 2, received: true, truncated: false });
    expect(source.state.cursors).toEqual({ "srv-web": { ids: [], ts: end }, "srv-worker": { ids: [], ts: end } });
    expect(source.state.services).toEqual({
      "srv-web": { name: "web", region: "oregon", type: "web_service" },
      "srv-worker": { name: "worker", region: "oregon", type: "web_service" },
    });
  });

  it("spends at most the page budget, keeps the pages read, and continues there without gaps or repeats", async () => {
    const logs = lines(3_000, "2026-11-25T09:55:00Z");
    const api = render({ logs, services: [web] });
    const ingest = collector();

    const first = await pullRenderAccount({ apiKey: "key", fetch: api.fetch, forward: ingest.forward, now, sources: [workspaceSource()] });

    expect(api.logQueries).toHaveLength(24);
    expect(first.pages).toBe(24);
    expect(first.behind).toBe(true);
    // Each page after the first repeats the line at its start.
    expect(ingest.sent).toHaveLength(24 * 100 - 23);

    const second = await pullRenderAccount({
      apiKey: "key",
      fetch: api.fetch,
      forward: ingest.forward,
      now: new Date(now.getTime() + 60_000),
      sources: [workspaceSource(first.sources.get("source-workspace")!.state)],
    });

    expect(second.behind).toBe(false);
    expect(ingest.sent).toEqual(logs.map((line) => line.message));
  });

  it("splits the budget across the regions a workspace runs in", async () => {
    const api = render({
      logs: [...lines(2_000, "2026-11-25T09:56:00Z", "srv-web"), ...lines(2_000, "2026-11-25T09:56:00Z", "srv-eu")],
      services: [web, eu],
    });
    const ingest = collector();

    await pullRenderAccount({ apiKey: "key", fetch: api.fetch, forward: ingest.forward, now, pageBudget: 24, sources: [workspaceSource()] });

    const byRegion = (resource: string) => api.logQueries.filter((query) => query.resources.includes(resource)).length;
    expect(byRegion("srv-web")).toBe(12);
    expect(byRegion("srv-eu")).toBe(12);
    expect(api.logQueries.every((query) => query.resources.length === 1)).toBe(true);
  });

  it.each([
    [429, { message: "rate limit exceeded" }],
    [503, { message: "log retrieval is currently unavailable" }],
  ])("keeps the pages read before HTTP %i %j and reads again on the next pass, without an error", async (status, body) => {
    const logs = lines(500, "2026-11-25T09:56:00Z");
    const api = render({ logFailures: { 2: { body, status } }, logs, services: [web] });
    const ingest = collector();

    const first = await pullRenderAccount({ apiKey: "key", fetch: api.fetch, forward: ingest.forward, now, sources: [workspaceSource()] });

    expect(first.retryLater).toBe(true);
    expect(first.sources.get("source-workspace")).toMatchObject({ error: null, received: true });
    expect(ingest.sent).toEqual(logs.slice(0, 199).map((line) => line.message));

    await pullRenderAccount({
      apiKey: "key",
      fetch: api.fetch,
      forward: ingest.forward,
      now: new Date(now.getTime() + 60_000),
      sources: [workspaceSource(first.sources.get("source-workspace")!.state)],
    });

    expect(ingest.sent).toEqual(logs.map((line) => line.message));
  });

  it("stops reading for the key once Render limits it", async () => {
    const api = render({ logFailures: { 0: { body: { message: "rate limit exceeded" }, status: 429 } }, logs: [log("2026-11-25T09:58:00Z", "a")], services: [web, eu] });
    const ingest = collector();

    const result = await pullRenderAccount({ apiKey: "key", fetch: api.fetch, forward: ingest.forward, now, sources: [workspaceSource()] });

    expect(api.logQueries).toHaveLength(1);
    expect(result).toMatchObject({ behind: true, retryLater: true });
    expect(result.sources.get("source-workspace")).toMatchObject({ error: null, received: false });
    expect(ingest.forward).not.toHaveBeenCalled();
  });

  it("reports a failed first page and moves nothing", async () => {
    const api = render({ logFailures: { 0: { body: { message: "invalid resource" }, status: 400 } }, services: [web] });
    const source = workspaceSource({ cursors: { "srv-web": { ids: [], ts: "2026-11-25T09:59:00Z" } } });

    const result = await pullRenderAccount({ apiKey: "key", fetch: api.fetch, forward: collector().forward, now, sources: [source] });

    expect(result.sources.get("source-workspace")).toMatchObject({
      error: "Logs: Render answered 400: invalid resource",
      received: false,
      state: { cursors: { "srv-web": { ids: [], ts: "2026-11-25T09:59:00Z" } } },
    });
  });

  it("refuses every source when Render refuses the key", async () => {
    const api = render({ services: [web], servicesStatus: 401 });

    const result = await pullRenderAccount({
      apiKey: "key",
      fetch: api.fetch,
      forward: collector().forward,
      now,
      sources: [workspaceSource(), serviceSource(web)],
    });

    expect([...result.sources.values()].map((source) => source.error)).toEqual([renderRefusedKey, renderRefusedKey]);
    expect(api.logQueries).toHaveLength(0);
  });

  it("keeps the cursor when ingest refuses the logs", async () => {
    const api = render({ logs: [log("2026-11-25T09:59:10Z", "a")], services: [web] });
    const source = workspaceSource({ cursors: { "srv-web": { ids: [], ts: "2026-11-25T09:59:00Z" } } });

    const result = await pullRenderAccount({ apiKey: "key", fetch: api.fetch, forward: collector(false).forward, now, sources: [source] });

    expect(result.sources.get("source-workspace")).toMatchObject({
      error: "Logs: Telemetry ingest did not accept the logs",
      state: { cursors: { "srv-web": { ids: [], ts: "2026-11-25T09:59:00Z" } } },
    });
  });

  it("sends a line at the cursor's time once, by its ID", async () => {
    const api = render({
      logs: [log("2026-11-25T09:59:00Z", "sent", "srv-web", "a"), log("2026-11-25T09:59:00Z", "new at the same time", "srv-web", "b"), log("2026-11-25T09:59:00Z", "no id", "srv-web", null)],
      services: [web],
    });
    const ingest = collector();
    const source = workspaceSource({ cursors: { "srv-web": { ids: ["a"], ts: "2026-11-25T09:59:00Z" } } });

    await pullRenderAccount({ apiKey: "key", fetch: api.fetch, forward: ingest.forward, now, sources: [source] });

    expect(ingest.sent).toEqual(["new at the same time"]);
  });

  it("gives a service with a source of its own only to that source", async () => {
    const api = render({ logs: [log("2026-11-25T09:58:00Z", "web line"), log("2026-11-25T09:58:00Z", "worker line", "srv-worker")], services: [web, worker] });
    const ingest = collector();

    const result = await pullRenderAccount({
      apiKey: "key",
      fetch: api.fetch,
      forward: ingest.forward,
      now,
      sources: [workspaceSource(), serviceSource(web)],
    });

    expect(ingest.sent.sort()).toEqual(["web line", "worker line"]);
    expect(result.sources.get("source-workspace")).toMatchObject({ logs: 1, state: { cursors: { "srv-worker": { ts: end } } } });
    // The workspace keeps web's cursor too, for when web's own source is removed.
    expect(result.sources.get("source-workspace")!.state.cursors).toEqual({ "srv-web": { ids: [], ts: end }, "srv-worker": { ids: [], ts: end } });
    expect(result.sources.get("source-srv-web")).toMatchObject({ logs: 1, state: { cursors: { "srv-web": { ts: end } }, region: "oregon", serviceName: "web" } });
  });

  it("hands a service's cursor over when it gets a source of its own and when that source is removed", async () => {
    const logs = [...lines(600, "2026-11-25T09:54:00Z", "srv-web"), ...lines(600, "2026-11-25T09:54:00Z", "srv-worker")]
      .map((line, index) => ({ ...line, timestamp: new Date(Date.parse("2026-11-25T09:54:00Z") + index * 300).toISOString() }));
    const api = render({ logs, services: [web, worker] });
    const ingest = collector();
    const pass = async (minute: number, sources: RenderPullSource[]) => (await pullRenderAccount({
      apiKey: "key",
      fetch: api.fetch,
      forward: ingest.forward,
      now: new Date(Date.parse("2026-11-25T09:55:00Z") + minute * 60_000),
      sources,
    })).sources;

    // The workspace alone, then with a source for web, then alone again.
    let workspace = (await pass(0, [workspaceSource()])).get("source-workspace")!.state;
    const second = await pass(1, [workspaceSource(workspace), serviceSource(web)]);
    workspace = second.get("source-workspace")!.state;
    expect(Object.keys(workspace.cursors as object).sort()).toEqual(["srv-web", "srv-worker"]);
    workspace = (await pass(2, [workspaceSource(workspace)])).get("source-workspace")!.state;
    await pass(3, [workspaceSource(workspace)]);

    expect(ingest.sent.length).toBe(new Set(ingest.sent).size);
    const until = Date.parse("2026-11-25T09:58:00Z") - 20_000;
    expect(ingest.sent.sort()).toEqual(logs.filter((line) => Date.parse(line.timestamp) >= Date.parse("2026-11-25T09:50:00Z") && Date.parse(line.timestamp) <= until).map((line) => line.message).sort());
  });

  it("keeps the workspace's copy of a service's cursor when that service is read in another region's read", async () => {
    const api = render({ logs: [log("2026-11-25T09:58:00Z", "web line"), log("2026-11-25T09:58:00Z", "eu line", "srv-eu")], services: [web, eu] });

    const result = await pullRenderAccount({ apiKey: "key", fetch: api.fetch, forward: collector().forward, now, sources: [workspaceSource(), serviceSource(web)] });

    expect(result.sources.get("source-workspace")!.state.cursors).toEqual({ "srv-eu": { ids: [], ts: end }, "srv-web": { ids: [], ts: end } });
  });

  it("gives every read a turn when there are more reads than pages", async () => {
    const services = ["oregon", "ohio", "frankfurt"].map((region) => ({ id: `srv-${region}`, name: region, ownerId: "tea-1", region }));
    const api = render({ logs: services.map((service) => log("2026-11-25T09:58:00Z", `${service.name} line`, service.id)), services });
    const ingest = collector();
    let state: Record<string, unknown> = {};

    for (let minute = 0; minute < 3; minute += 1) {
      state = (await pullRenderAccount({
        apiKey: "key",
        fetch: api.fetch,
        forward: ingest.forward,
        now: new Date(now.getTime() + minute * 60_000),
        pageBudget: 1,
        sources: [workspaceSource(state)],
      })).sources.get("source-workspace")!.state;
    }

    expect(ingest.sent.sort()).toEqual(["frankfurt line", "ohio line", "oregon line"]);
  });

  it("keeps the cursors of reads delivered before Render refused the key", async () => {
    const api = render({ logFailures: { 1: { body: { message: "unauthorized" }, status: 401 } }, logs: [log("2026-11-25T09:58:00Z", "web line"), log("2026-11-25T09:58:00Z", "eu line", "srv-eu")], services: [web, eu] });
    const ingest = collector();

    const result = await pullRenderAccount({ apiKey: "key", fetch: api.fetch, forward: ingest.forward, now, sources: [workspaceSource()] });

    const source = result.sources.get("source-workspace")!;
    expect(source.error).toBe(renderRefusedKey);
    expect(ingest.sent).toHaveLength(1);
    // The read that was delivered moved its service's cursor to the end.
    expect(Object.values(source.state.cursors as Record<string, { ts: string }>).map((cursor) => cursor.ts)).toContain(end);
  });

  it("reports a workspace whose services were never listed and cannot be listed now", async () => {
    const api = render({ services: [web], servicesStatus: 503 });

    const result = await pullRenderAccount({ apiKey: "key", fetch: api.fetch, forward: collector().forward, now, sources: [workspaceSource()] });

    expect(result.sources.get("source-workspace")!.error).toMatch(/^Logs: Render could not list the workspace's services/u);
  });

  it("leaves a service with its own source under another connection to that source", async () => {
    const api = render({ logs: [log("2026-11-25T09:58:00Z", "web line"), log("2026-11-25T09:58:00Z", "worker line", "srv-worker")], services: [web, worker] });
    const ingest = collector();

    await pullRenderAccount({ apiKey: "key", fetch: api.fetch, forward: ingest.forward, now, readElsewhere: new Set(["srv-web"]), sources: [workspaceSource()] });

    expect(ingest.sent).toEqual(["worker line"]);
  });

  it("skips ahead when a service fell more than an hour behind, and says so", async () => {
    const api = render({ logs: [log("2026-11-25T08:00:00Z", "ancient"), log("2026-11-25T09:30:00Z", "recent")], services: [web] });
    const ingest = collector();

    const result = await pullRenderAccount({
      apiKey: "key",
      fetch: api.fetch,
      forward: ingest.forward,
      now,
      sources: [serviceSource(web, { cursors: { "srv-web": { ids: [], ts: "2026-11-25T07:00:00Z" } } })],
    });

    expect(api.logQueries[0]!.startTime).toBe("2026-11-25T09:00:00.000Z");
    expect(ingest.sent).toEqual(["recent"]);
    expect(result.sources.get("source-srv-web")).toMatchObject({ truncated: true });
  });

  it("skips suspended services and reports a service Render no longer lists", async () => {
    const api = render({ services: [{ ...web, suspended: true }] });

    const result = await pullRenderAccount({
      apiKey: "key",
      fetch: api.fetch,
      forward: collector().forward,
      now,
      sources: [serviceSource(web), serviceSource(worker)],
    });

    expect(api.logQueries).toHaveLength(0);
    expect(result.sources.get("source-srv-web")).toMatchObject({ error: null });
    expect(result.sources.get("source-srv-worker")!.error).toMatch(/no longer lists this service/u);
  });

  it("reads the services last listed when listing fails", async () => {
    const api = render({ logs: [log("2026-11-25T09:58:00Z", "still read")], services: [web], servicesStatus: 500 });
    const ingest = collector();

    await pullRenderAccount({
      apiKey: "key",
      fetch: api.fetch,
      forward: ingest.forward,
      now,
      sources: [workspaceSource({ services: { "srv-web": { name: "web", region: "oregon" } } })],
    });

    expect(ingest.sent).toEqual(["still read"]);
  });

  it("reports a source whose settings are broken", async () => {
    const result = await pullRenderAccount({
      apiKey: "key",
      fetch: render({}).fetch,
      forward: collector().forward,
      now,
      sources: [{ externalId: "tea-1", id: "broken", state: { kind: "workspace" } }],
    });

    expect(result.sources.get("broken")!.error).toMatch(/Remove it and add it again/u);
  });
});

describe("cursors", () => {
  it("never move back and gather the IDs at their time", () => {
    const cursor = advanceCursor({ ids: ["a"], ts: "2026-11-25T10:00:00Z" }, "2026-11-25T10:00:00Z", [log("2026-11-25T10:00:00Z", "x", "srv-web", "b")]);

    expect(cursor).toEqual({ ids: ["a", "b"], ts: "2026-11-25T10:00:00Z" });
    expect(advanceCursor(cursor, "2026-11-25T09:00:00Z", [])).toBe(cursor);
    expect(sentBefore(cursor, { id: "c", timestamp: "2026-11-25T10:00:00Z" })).toBe(false);
    expect(sentBefore(cursor, { id: "a", timestamp: "2026-11-25T10:00:00Z" })).toBe(true);
    expect(sentBefore(cursor, { id: null, timestamp: "2026-11-25T09:59:59.999999Z" })).toBe(true);
  });
});
