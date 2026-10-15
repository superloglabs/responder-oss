import { describe, expect, it } from "vitest";
import { syntheticHeaders, syntheticRequest } from "./synthetic-checks.js";

const url = "https://api.example.com/health";

describe("syntheticHeaders", () => {
  it("splits secret values out of the stored headers", () => {
    expect(
      syntheticHeaders(
        [
          { name: "Authorization", secret: true, value: "Bearer abc" },
          { name: "Accept", secret: false, value: "application/json" },
        ],
        null,
        url,
      ),
    ).toEqual({
      headers: [
        { name: "Authorization", secret: true, value: "" },
        { name: "Accept", secret: false, value: "application/json" },
      ],
      secrets: { authorization: "Bearer abc" },
    });
  });

  it("keeps a saved secret left blank while the origin stays the same", () => {
    const saved = { secrets: { authorization: "Bearer abc" }, url };
    expect(syntheticHeaders([{ name: "Authorization", secret: true, value: null }], saved, `${url}?deep=1`)).toMatchObject({
      secrets: { authorization: "Bearer abc" },
    });
    expect(syntheticHeaders([{ name: "Authorization", secret: true, value: null }], saved, "https://evil.example.net/")).toEqual({
      error: "Enter the Authorization value again, since the URL's host changed",
    });
  });

  it("asks for a new secret's value and rejects repeated names", () => {
    expect(syntheticHeaders([{ name: "X-Key", secret: true, value: null }], null, url)).toEqual({
      error: "Enter a value for the X-Key header",
    });
    expect(
      syntheticHeaders(
        [
          { name: "X-A", secret: false, value: "1" },
          { name: "x-a", secret: false, value: "2" },
        ],
        null,
        url,
      ),
    ).toEqual({ error: "Set the x-a header once" });
  });
});

describe("syntheticRequest", () => {
  it("fills secret values back in", () => {
    expect(
      syntheticRequest(
        {
          body: null,
          followRedirects: true,
          headers: [{ name: "Authorization", secret: true, value: "" }],
          method: "GET",
          timeoutMs: 5_000,
          url,
        },
        { authorization: "Bearer abc" },
      ).headers,
    ).toEqual([{ name: "Authorization", secret: true, value: "Bearer abc" }]);
  });
});
