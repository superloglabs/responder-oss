import { describe, expect, it } from "vitest";
import {
  createJobBoss,
  investigationJobSchema,
  investigationQueue,
  remediationJobSchema,
  workerHealthJobSchema,
  workerHealthQueue,
} from "./jobs.js";

describe("background jobs", () => {
  it("uses a stable worker health queue name", () => {
    expect(workerHealthQueue).toBe("responder-worker-health");
    expect(investigationQueue).toBe("responder-investigations");
  });

  it("accepts an investigation job", () => {
    expect(
      investigationJobSchema.parse({
        kind: "investigation",
        config: {
          agentId: "7f83b096-1299-47d3-bd10-d617463a15d1",
          id: "684a11c5-f5b8-4ff5-b157-592e04164dd3",
          model: "instance/default",
          organizationId: "9ba9e0a6-b15c-4674-bf91-18d70b6ff450",
          prMode: "manual",
          prompt: "Investigate carefully.",
        },
        investigationId: "9ec74cbd-b9bd-452b-932f-19bc64084203",
        queuedAt: "2026-08-05T08:00:00.000Z",
        request: {
          agentId: "7f83b096-1299-47d3-bd10-d617463a15d1",
          body: "The API is returning HTTP 500.",
          externalEventId: "event-1",
          provider: "sentry",
          title: "Production error",
        },
        runtimeProfileId: "cf72339f-a631-448f-b8af-f9d8336ad879",
      }).investigationId,
    ).toBe("9ec74cbd-b9bd-452b-932f-19bc64084203");
  });

  it("accepts a remediation job", () => {
    expect(
      remediationJobSchema.parse({
        kind: "remediation",
        config: {
          agentId: "7f83b096-1299-47d3-bd10-d617463a15d1",
          id: "684a11c5-f5b8-4ff5-b157-592e04164dd3",
          model: "instance/default",
          organizationId: "9ba9e0a6-b15c-4674-bf91-18d70b6ff450",
          prMode: "manual",
          prompt: "Investigate carefully.",
        },
        investigationId: "9ec74cbd-b9bd-452b-932f-19bc64084203",
        issue: {
          id: "6e55b174-e903-4d76-973f-9dff4a4e9883",
          title: "Broken route",
          description: "The route throws.",
          severity: "SEV-2",
          remediation: "Handle the missing value.",
          evidence: [],
        },
        queuedAt: "2026-08-05T08:00:00.000Z",
        remediationRequestId: "4614c371-a4a3-4342-a9a8-36e526377345",
        runtimeProfileId: "cf72339f-a631-448f-b8af-f9d8336ad879",
      }).kind,
    ).toBe("remediation");
  });

  it("accepts a valid health job", () => {
    expect(
      workerHealthJobSchema.parse({
        marker: "test-123",
        requestedAt: "2026-08-05T08:00:00.000Z",
      }),
    ).toEqual({
      marker: "test-123",
      requestedAt: "2026-08-05T08:00:00.000Z",
    });
  });

  it("rejects an incomplete health job", () => {
    expect(() => workerHealthJobSchema.parse({ marker: "" })).toThrow();
  });

  it("requires database configuration", () => {
    expect(() => createJobBoss({})).toThrow(
      "Database configuration is required for background jobs",
    );
  });
});
