import { describe, expect, it } from "vitest";
import { connectionHandoffUrl } from "./connection-handoff";

describe("connectionHandoffUrl", () => {
  it("returns a connection result from an automation popup to its completion page", () => {
    expect(connectionHandoffUrl({ search: "?integration=sentry&status=finishing", windowName: "automation-connect-4b7c", pendingDraft: null }))
      .toBe("/automations/connection-complete?request=4b7c&integration=sentry&status=finishing");
  });

  it("returns a same-tab connection result to the saved automation draft", () => {
    expect(connectionHandoffUrl({ search: "?integration=sentry&status=finishing", windowName: "", pendingDraft: { connecting: "sentry" } }))
      .toBe("/automations/new?integration=sentry&status=finishing");
  });

  it("returns a same-tab connection result to the saved automation it edits", () => {
    expect(connectionHandoffUrl({ search: "?integration=sentry&status=finishing", windowName: "", pendingDraft: { automationId: "4b7c", connecting: "sentry" } }))
      .toBe("/automations/4b7c?integration=sentry&status=finishing");
  });

  it("keeps the failure reason for a popup", () => {
    expect(connectionHandoffUrl({ search: "?integration=sentry&status=error&reason=cancelled", windowName: "automation-connect-4b7c", pendingDraft: null }))
      .toBe("/automations/connection-complete?request=4b7c&integration=sentry&status=error&reason=cancelled");
  });

  it("leaves settings connections alone", () => {
    expect(connectionHandoffUrl({ search: "?integration=sentry&status=connected", windowName: "", pendingDraft: null })).toBeNull();
    expect(connectionHandoffUrl({ search: "?integration=slack&status=finishing", windowName: "", pendingDraft: { connecting: "sentry" } })).toBeNull();
    // Flows that honor their return path never reach settings for a draft.
    expect(connectionHandoffUrl({ search: "?integration=sentry&status=connected", windowName: "", pendingDraft: { connecting: "sentry" } })).toBeNull();
    expect(connectionHandoffUrl({ search: "", windowName: "automation-connect-4b7c", pendingDraft: { connecting: "sentry" } })).toBeNull();
  });
});
