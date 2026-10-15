import { describe, expect, it, vi } from "vitest";
import { createVercelDrains, deleteVercelDrain, vercelDrainPayload, VercelDrainError } from "./vercel-drains.js";

const target = { accessToken: "token", ingestKey: "sl_ingest_x", ingestOrigin: "https://eu.superlog.sh/", name: "superlog-abc", projectIds: null, teamId: "team_1" };

describe("vercelDrainPayload", () => {
  it("sends traces as OTLP to the ingest endpoint and logs to the Vercel adapter", () => {
    expect(vercelDrainPayload({ ...target, signal: "traces" })).toEqual({
      delivery: { encoding: "proto", endpoint: { traces: "https://eu.superlog.sh/api/ingest/v1/traces" }, headers: { "x-api-key": "sl_ingest_x" }, type: "otlphttp" },
      name: "superlog-abc-traces",
      projects: "all",
      schemas: { trace: { version: "v1" } },
    });
    expect(vercelDrainPayload({ ...target, projectIds: ["prj_1"], signal: "logs" })).toMatchObject({
      delivery: { encoding: "ndjson", endpoint: "https://eu.superlog.sh/api/ingest/vercel/logs", type: "http" },
      projectIds: ["prj_1"],
      projects: "some",
      schemas: { log: { version: "v1" } },
    });
  });
});

describe("createVercelDrains", () => {
  it("creates a drain per signal on the team", async () => {
    let id = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ id: `drn_${++id}` }));

    await expect(createVercelDrains(target, fetchImpl as unknown as typeof fetch)).resolves.toEqual({ logs: "drn_2", traces: "drn_1" });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.vercel.com/v1/drains?teamId=team_1");
  });

  it("removes the drains it made when one fails", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return url.includes("drains") && fetchImpl.mock.calls.length === 1
        ? Response.json({ id: "drn_1" })
        : Response.json({ error: { message: "Drains are not available on this plan" } }, { status: 403 });
    });

    const failure = await createVercelDrains(target, fetchImpl as unknown as typeof fetch).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(VercelDrainError);
    expect(failure).toMatchObject({ message: "Drains are not available on this plan", status: 403 });
    expect(fetchImpl).toHaveBeenLastCalledWith("https://api.vercel.com/v1/drains/drn_1?teamId=team_1", expect.objectContaining({ method: "DELETE" }));
  });
});

describe("deleteVercelDrain", () => {
  it("treats a missing drain as deleted", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(deleteVercelDrain({ accessToken: "t", teamId: null }, "drn_1", fetchImpl as unknown as typeof fetch)).resolves.toBeUndefined();
  });
});
