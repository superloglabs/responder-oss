import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildVercelReadUrl,
  createVercelTools,
  executeVercelRead,
  searchVercelOperations,
} from "./vercel.js";

const connection = {
  accessToken: "sensitive-vercel-token",
  accountId: "04040404-0404-4404-8404-040404040404",
  displayName: "Acme",
  projectIds: ["prj-1"],
  teamId: "team-1",
};

describe("Vercel read tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("searches broad read operations without exposing secret endpoints", () => {
    expect(
      searchVercelOperations("deployment runtime logs", 20).map(
        ({ operationId }) => operationId,
      ),
    ).toContain("getRuntimeLogs");
    expect(
      searchVercelOperations("environment variables decrypted token secret", 20),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringMatching(/\/(?:env|secrets?|tokens?)(?:\/|$)/iu),
        }),
      ]),
    );
  });

  it("exposes strict-compatible parameter arrays and converts them internally", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ id: "prj-1" }));
    vi.stubGlobal("fetch", fetchMock);
    const callTool = createVercelTools([connection]).find(
      ({ name }) => name === "call_vercel_api",
    )!;

    expect(callTool.parameters).toMatchObject({
      properties: {
        pathParameters: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              value: expect.any(Object),
            },
            required: ["name", "value"],
            additionalProperties: false,
          },
        },
        queryParameters: { type: "array" },
      },
      required: expect.arrayContaining(["pathParameters", "queryParameters"]),
      additionalProperties: false,
    });

    await callTool.invoke(
      undefined as never,
      JSON.stringify({
        accountId: connection.accountId,
        operationId: "getProject",
        pathParameters: [{ name: "idOrName", value: "prj-1" }],
        queryParameters: [{ name: "teamId", value: "attacker-team" }],
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = new URL(fetchMock.mock.calls[0]![0] as URL);
    expect(requestedUrl.pathname).toBe("/v9/projects/prj-1");
    expect(requestedUrl.searchParams.get("teamId")).toBe("team-1");
  });

  it("rejects duplicate model-supplied parameter names", async () => {
    const callTool = createVercelTools([connection]).find(
      ({ name }) => name === "call_vercel_api",
    )!;

    await expect(
      callTool.invoke(
        undefined as never,
        JSON.stringify({
          accountId: connection.accountId,
          operationId: "getProject",
          pathParameters: [
            { name: "idOrName", value: "prj-1" },
            { name: "idOrName", value: "prj-other" },
          ],
          queryParameters: [],
        }),
      ),
    ).resolves.toContain("Duplicate Vercel path parameter: idOrName");
  });

  it("builds a fixed-origin, team-scoped project request", () => {
    const operation = searchVercelOperations("find project by id", 20).find(
      ({ operationId }) => operationId === "getProject",
    );
    expect(operation).toBeDefined();

    const url = buildVercelReadUrl({
      connection,
      operation: operation!,
      pathParameters: { idOrName: "prj-1" },
      queryParameters: { teamId: "attacker-team" },
    });

    expect(url.origin).toBe("https://api.vercel.com");
    expect(url.pathname).toBe("/v9/projects/prj-1");
    expect(url.searchParams.get("teamId")).toBe("team-1");
  });

  it("rejects project access outside the synchronized installation scope", () => {
    const operation = searchVercelOperations("find project by id", 20).find(
      ({ operationId }) => operationId === "getProject",
    );

    expect(() =>
      buildVercelReadUrl({
        connection,
        operation: operation!,
        pathParameters: { idOrName: "prj-other" },
      }),
    ).toThrow("not available to this connection");
  });

  it("rejects project arrays outside the selected project scope", () => {
    const operation = searchVercelOperations("list deployments", 20).find(
      ({ operationId }) => operationId === "getDeployments",
    );

    expect(() =>
      buildVercelReadUrl({
        connection,
        operation: operation!,
        queryParameters: { projectIds: ["prj-1", "prj-other"] },
      }),
    ).toThrow("not available to this connection");
  });

  it("requires an explicit selected-project filter when listing deployments", () => {
    const operation = searchVercelOperations("list deployments", 20).find(
      ({ operationId }) => operationId === "getDeployments",
    );

    expect(() =>
      buildVercelReadUrl({ connection, operation: operation! }),
    ).toThrow("Choose at least one selected Vercel project");
    expect(() =>
      buildVercelReadUrl({
        connection,
        operation: operation!,
        queryParameters: { projectIds: [] },
      }),
    ).toThrow("Choose at least one selected Vercel project");
  });

  it("normalizes team path parameters to the connected team", () => {
    const operation = searchVercelOperations("get a team", 20).find(
      ({ operationId }) => operationId === "getTeam",
    );

    expect(() =>
      buildVercelReadUrl({
        connection,
        operation: operation!,
        pathParameters: { teamId: "attacker-team" },
      }),
    ).toThrow("team is not available");
    expect(
      buildVercelReadUrl({ connection, operation: operation! }).pathname,
    ).toBe("/v2/teams/team-1");
  });

  it("cannot redirect an operation away from Vercel's API origin", () => {
    const operation = searchVercelOperations("find project by id", 20).find(
      ({ operationId }) => operationId === "getProject",
    );

    expect(() =>
      buildVercelReadUrl({
        connection,
        operation: { ...operation!, path: "//example.com/{idOrName}" },
        pathParameters: { idOrName: "prj-1" },
      }),
    ).toThrow("Invalid Vercel API path");
  });

  it("executes GET requests in the worker and redacts credential-shaped output", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        deployments: [{ id: "dpl-1", state: "ERROR" }],
        accessToken: "another-token",
        echoed: "sensitive-vercel-token",
        env: [{ key: "DATABASE_URL", value: "postgres://secret" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = JSON.parse(
      await executeVercelRead({
        connection,
        operationId: "getDeployments",
        queryParameters: { limit: 1, projectId: "prj-1" },
      }),
    ) as Record<string, unknown>;

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.origin).toBe("https://api.vercel.com");
    expect(url.searchParams.get("teamId")).toBe("team-1");
    expect(init.method).toBeUndefined();
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer sensitive-vercel-token",
    );
    expect(JSON.stringify(result)).not.toContain("sensitive-vercel-token");
    expect(JSON.stringify(result)).not.toContain("another-token");
    expect(JSON.stringify(result)).not.toContain("postgres://secret");
    expect(JSON.stringify(result)).toContain("[redacted]");
  });

  it("verifies deployment ownership before calling deployment-scoped operations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ id: "dpl-1", projectId: "prj-other" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeVercelRead({
        connection,
        operationId: "getDeploymentEvents",
        pathParameters: { idOrUrl: "dpl-1" },
      }),
    ).rejects.toThrow("deployment is not available");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(fetchMock.mock.calls[0]![0] as URL).pathname).toBe(
      "/v13/deployments/dpl-1",
    );
  });

  it("verifies deployment ownership even with a selected project parameter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ id: "dpl-other", projectId: "prj-other" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      executeVercelRead({
        connection,
        operationId: "getRuntimeLogs",
        pathParameters: {
          deploymentId: "dpl-other",
          projectId: "prj-1",
        },
      }),
    ).rejects.toThrow("deployment is not available");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses operations absent from the generated read catalog", async () => {
    await expect(
      executeVercelRead({
        connection,
        operationId: "createDeployment",
      }),
    ).rejects.toThrow("Unknown or blocked Vercel read operation");
  });
});
