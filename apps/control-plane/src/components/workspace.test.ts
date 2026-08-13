import { describe, expect, it } from "vitest";
import { workspaceSlug } from "./workspace";

describe("workspaceSlug", () => {
  it("keeps the readable name and adds an internal unique suffix", () => {
    expect(workspaceSlug("Google", "workspace-id")).toBe(
      "google-workspace-id",
    );
  });

  it("allows duplicate workspace names to receive different slugs", () => {
    expect(workspaceSlug("Google", "first")).not.toBe(
      workspaceSlug("Google", "second"),
    );
  });

  it("rejects names without letters or numbers", () => {
    expect(workspaceSlug("---", "workspace-id")).toBe("");
  });
});
