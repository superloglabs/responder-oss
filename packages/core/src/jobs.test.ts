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
          agentId: "13131313-1313-4313-8313-131313131313",
          id: "08080808-0808-4808-8808-080808080808",
          model: "instance/default",
          organizationId: "15151515-1515-4515-8515-151515151515",
          prMode: "manual",
          prompt: "Investigate carefully.",
        },
        investigationId: "16161616-1616-4616-8616-161616161616",
        queuedAt: "2026-08-05T08:00:00.000Z",
        request: {
          agentId: "13131313-1313-4313-8313-131313131313",
          body: "The API is returning HTTP 500.",
          externalEventId: "event-1",
          provider: "sentry",
          title: "Production error",
        },
        runtimeProfileId: "19191919-1919-4919-8919-191919191919",
      }).investigationId,
    ).toBe("16161616-1616-4616-8616-161616161616");
  });

  it("accepts a remediation job", () => {
    expect(
      remediationJobSchema.parse({
        kind: "remediation",
        config: {
          agentId: "13131313-1313-4313-8313-131313131313",
          id: "08080808-0808-4808-8808-080808080808",
          model: "instance/default",
          organizationId: "15151515-1515-4515-8515-151515151515",
          prMode: "manual",
          prompt: "Investigate carefully.",
        },
        investigationId: "16161616-1616-4616-8616-161616161616",
        issue: {
          id: "10101010-1010-4010-8010-101010101010",
          title: "Broken route",
          description: "The route throws.",
          severity: "SEV-2",
          remediation: "Handle the missing value.",
          evidence: [],
        },
        queuedAt: "2026-08-05T08:00:00.000Z",
        remediationRequestId: "05050505-0505-4505-8505-050505050505",
        runtimeProfileId: "19191919-1919-4919-8919-191919191919",
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
