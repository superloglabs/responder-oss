import { describe, expect, it } from "vitest";
import { gcpReadOnlyToolFilter } from "./gcp.js";

describe("GCP MCP", () => {
  it("exposes only tools explicitly annotated read-only", async () => {
    await expect(
      gcpReadOnlyToolFilter({}, {
        annotations: { readOnlyHint: true },
        name: "list_assets",
      }),
    ).resolves.toBe(true);
    await expect(
      gcpReadOnlyToolFilter({}, {
        annotations: { readOnlyHint: false },
        name: "create_alert_policy",
      }),
    ).resolves.toBe(false);
    await expect(
      gcpReadOnlyToolFilter({}, { name: "unknown_tool" }),
    ).resolves.toBe(false);
  });
});
