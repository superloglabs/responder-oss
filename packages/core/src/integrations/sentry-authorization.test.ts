import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestSentryTokenRefresh } from "./sentry-authorization.js";

const installationId = "40000000-0000-4000-8000-000000000000";
const input = {
  clientId: "sentry-client",
  clientSecret: "sentry-secret",
  installationId,
  refreshToken: "stored-refresh-token",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requestSentryTokenRefresh", () => {
  it("refreshes with the stored refresh token", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      Response.json({ token: "fresh-token", refreshToken: "fresh-refresh-token" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await requestSentryTokenRefresh(input);

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://sentry.io/api/0/sentry-app-installations/${installationId}/authorizations/`,
    );
    expect(JSON.parse(request.body as string)).toEqual({
      grant_type: "refresh_token",
      refresh_token: "stored-refresh-token",
      client_id: "sentry-client",
      client_secret: "sentry-secret",
    });
  });

  it.each([400, 401, 403])(
    "gets a token with a client-secret JWT when Sentry rejects the refresh token with %i",
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status }))
        .mockResolvedValueOnce(
          Response.json({ token: "fresh-token", refreshToken: "fresh-refresh-token" }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const response = await requestSentryTokenRefresh(input);

      expect(response.status).toBe(200);
      const [, jwtRequest] = fetchMock.mock.calls[1];
      const jwt = (jwtRequest.headers.authorization as string).slice("Bearer ".length);
      const [encodedHeader, encodedPayload, encodedSignature] = jwt.split(".");
      expect(JSON.parse(Buffer.from(encodedHeader, "base64url").toString())).toEqual({
        alg: "HS256",
        typ: "JWT",
      });
      const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString());
      expect(payload).toEqual(
        expect.objectContaining({ iss: "sentry-client", sub: "sentry-client" }),
      );
      expect(payload.exp - payload.iat).toBe(60);
      expect(encodedSignature).toBe(
        createHmac("sha256", "sentry-secret")
          .update(`${encodedHeader}.${encodedPayload}`)
          .digest("base64url"),
      );
      expect(JSON.parse(jwtRequest.body as string)).toEqual({
        grant_type: "urn:sentry:params:oauth:grant-type:jwt-bearer",
      });
    },
  );

  it("returns the JWT grant's rejection when the installation is gone", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(new Response(null, { status: 401 })),
    );

    await expect(requestSentryTokenRefresh(input)).resolves.toMatchObject({ status: 401 });
  });

  it("leaves provider outages to the caller's retry", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestSentryTokenRefresh(input)).resolves.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
