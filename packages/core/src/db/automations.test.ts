import { describe, expect, it, vi } from "vitest";
import { summarizeAutomationList } from "./automations.js";

vi.mock("./client.js", () => ({ getDatabase: vi.fn() }));

describe("summarizeAutomationList", () => {
  it("lists GitHub first, then context providers alphabetically", () => {
    const [row] = summarizeAutomationList(
      [{ id: "automation-1", versionId: "version-1" }],
      {
        accountRows: [
          { provider: "slack", versionId: "version-1" },
          { provider: "datadog", versionId: "version-1" },
          { provider: "sentry", versionId: "version-1" },
        ],
        repositoryRows: [{ versionId: "version-1" }],
        runRows: [],
      },
    );

    expect(row?.connectors).toEqual(["github", "datadog", "sentry", "slack"]);
  });

  it("attaches connectors and the latest run to each automation", () => {
    const runAt = new Date("2026-09-24T10:00:00Z");
    const rows = summarizeAutomationList(
      [
        { id: "automation-1", name: "Errors", versionId: "version-1" },
        { id: "automation-2", name: "Docs", versionId: "version-2" },
      ],
      {
        accountRows: [
          { provider: "sentry", versionId: "version-1" },
          { provider: "datadog", versionId: "version-1" },
          { provider: "slack", versionId: "version-2" },
        ],
        repositoryRows: [{ versionId: "version-1" }],
        runRows: [{ automationId: "automation-1", createdAt: runAt, status: "failed" }],
      },
    );

    expect(rows).toEqual([
      {
        connectors: ["github", "datadog", "sentry"],
        id: "automation-1",
        lastRun: { createdAt: runAt, status: "failed" },
        name: "Errors",
      },
      { connectors: ["slack"], id: "automation-2", lastRun: null, name: "Docs" },
    ]);
  });
});
