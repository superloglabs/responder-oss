import { afterEach, describe, expect, it, vi } from "vitest";
import { createRailwayTools, railwayConnectionLabel } from "./railway.js";

const readOnly = {
  accessLevel: "read_only" as const,
  accessToken: "sensitive-railway-token",
  accountId: "05050505-0505-4505-8505-050505050505",
  displayName: "Acme",
  workspaces: [{ id: "w1", name: "Acme" }],
};
const redeploy = {
  ...readOnly,
  accessLevel: "redeploy" as const,
  accountId: "06060606-0606-4606-8606-060606060606",
  displayName: "Acme · redeploy",
};

describe("Railway tools", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("only reads in investigations, even with redeploy access", () => {
    const names = createRailwayTools([redeploy], { allowWrites: false }).map(({ name }) => name);

    expect(names).toContain("get_railway_deployment_logs");
    expect(names).not.toContain("redeploy_railway_deployment");
    expect(names).not.toContain("restart_railway_deployment");
  });

  it("adds redeploy and restart in tag mode for redeploy connections", () => {
    expect(createRailwayTools([readOnly], { allowWrites: true }).map(({ name }) => name))
      .not.toContain("redeploy_railway_deployment");
    expect(createRailwayTools([redeploy], { allowWrites: true }).map(({ name }) => name))
      .toEqual(expect.arrayContaining(["redeploy_railway_deployment", "restart_railway_deployment"]));
  });

  it("refuses to redeploy through a read-only connection", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const tool = createRailwayTools([readOnly, redeploy], { allowWrites: true })
      .find(({ name }) => name === "redeploy_railway_deployment")!;

    const result = await tool.invoke(
      undefined as never,
      JSON.stringify({ accountId: readOnly.accountId, deploymentId: "d1" }),
    );

    expect(String(result)).toContain("not available to this run");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls Railway with the selected connection's token", async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: { logs: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    const tool = createRailwayTools([readOnly], { allowWrites: false })
      .find(({ name }) => name === "get_railway_environment_logs")!;

    await expect(tool.invoke(
      undefined as never,
      JSON.stringify({ accountId: null, endDate: null, environmentId: "e1", filter: null, limit: 50 }),
    )).resolves.toBe('{"logs":[]}');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sensitive-railway-token");
    expect(JSON.parse(String(init.body)).variables).toMatchObject({ beforeLimit: 50, environmentId: "e1" });
  });

  it("labels a connection by its quoted workspaces", () => {
    expect(railwayConnectionLabel(readOnly)).toBe('"Acme" (workspaceId w1)');
    expect(railwayConnectionLabel({ ...readOnly, workspaces: [] })).toBe('"Acme"');
  });
});
