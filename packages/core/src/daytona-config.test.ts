import { describe, expect, it } from "vitest";
import {
  isDaytonaNotFound,
  requireDaytonaClientConfig,
} from "./daytona-config.js";

describe("Daytona client configuration", () => {
  it("omits blank optional settings", () => {
    expect(
      requireDaytonaClientConfig({
        DAYTONA_API_KEY: "api-key",
        DAYTONA_API_URL: " ",
        DAYTONA_TARGET: "",
      }),
    ).toEqual({
      daytonaApiKey: "api-key",
      daytonaApiUrl: undefined,
      daytonaTarget: undefined,
    });
  });

  it("recognizes not-found errors across package boundaries", () => {
    const namedError = new Error("missing");
    namedError.name = "DaytonaNotFoundError";

    expect(isDaytonaNotFound(namedError)).toBe(true);
    expect(isDaytonaNotFound({ statusCode: 404 })).toBe(true);
    expect(isDaytonaNotFound({ statusCode: 500 })).toBe(false);
  });
});
