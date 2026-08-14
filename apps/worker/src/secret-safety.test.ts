import { describe, expect, it } from "vitest";
import {
  containsDaytonaSecretPlaceholder,
  workspaceSecretUsageInstructions,
} from "./secret-safety.js";

describe("workspace secret safety", () => {
  it("detects placeholders case-insensitively in binary file contents", () => {
    expect(
      containsDaytonaSecretPlaceholder(
        new TextEncoder().encode("token=DTN_SECRET_1234-ABCD"),
      ),
    ).toBe(true);
  });

  it("fails closed when a value cannot be inspected", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(containsDaytonaSecretPlaceholder(circular)).toBe(true);
  });

  it("renders one shared host-restricted usage policy", () => {
    const instructions = workspaceSecretUsageInstructions([
      {
        environmentVariable: "SERVICE_API_KEY",
        allowedHosts: ["api.example.com"],
      },
    ]);

    expect(instructions).toContain("SERVICE_API_KEY");
    expect(instructions).toContain("api.example.com");
    expect(instructions).toContain("Never send a placeholder to an unlisted host");
  });
});
