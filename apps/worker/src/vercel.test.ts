import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildVercelReadUrl,
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

  it("refuses operations absent from the generated read catalog", async () => {
    await expect(
      executeVercelRead({
        connection,
        operationId: "createDeployment",
      }),
    ).rejects.toThrow("Unknown or blocked Vercel read operation");
  });
});
