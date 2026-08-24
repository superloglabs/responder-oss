import { describe, expect, it } from "vitest";
import { apiErrorMessage } from "./agents-api";

describe("API error messages", () => {
  it("surfaces specific validation issues instead of the generic error", () => {
    expect(
      apiErrorMessage(
        {
          error: "Invalid workspace secret",
          issues: [
            { message: "Choose a non-system environment variable name" },
            { message: "Use a hostname without a scheme, path, or port" },
          ],
        },
        400,
      ),
    ).toBe(
      "Choose a non-system environment variable name. Use a hostname without a scheme, path, or port",
    );
  });

  it("falls back to the top-level API error", () => {
    expect(apiErrorMessage({ error: "Agent not found" }, 404)).toBe(
      "Agent not found",
    );
  });
});
