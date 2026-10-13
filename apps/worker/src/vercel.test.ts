import { afterEach, describe, expect, it, vi } from "vitest";
import { createVercelTools } from "./vercel.js";

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
        queryParameters: [],
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
});
