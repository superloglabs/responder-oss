import { describe, expect, it } from "vitest";
import { awsReadOnlyToolFilter } from "./aws.js";

describe("AWS MCP tool filtering", () => {
  it("exposes only tools explicitly annotated as read-only", async () => {
    await expect(
      awsReadOnlyToolFilter({}, { annotations: { readOnlyHint: true } }),
    ).resolves.toBe(true);
    await expect(
      awsReadOnlyToolFilter({}, { annotations: { readOnlyHint: false } }),
    ).resolves.toBe(false);
    await expect(awsReadOnlyToolFilter({}, { name: "unknown" })).resolves.toBe(
      false,
    );
  });
});
