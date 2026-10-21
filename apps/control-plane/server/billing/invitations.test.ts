import { APIError } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationBillingSummary } from "../../../../packages/core/src/billing/autumn.js";
import {
  assertWorkspaceCanInvite,
  invitationsNeedTeamPlan,
  TEAM_PLAN_REQUIRED,
} from "./invitations.js";

function dependencies(options: { includesTeammates: boolean; usageBased: boolean }) {
  return {
    getSummary: vi.fn(async () => ({
      includesTeammates: options.includesTeammates,
    }) as AutomationBillingSummary),
    usesUsageBilling: vi.fn(async () => options.usageBased),
  };
}

describe("invitationsNeedTeamPlan", () => {
  it("needs Team on a usage-billed plan without teammates", () => {
    expect(invitationsNeedTeamPlan({
      automations: { includesTeammates: false },
      usageBased: true,
    })).toBe(true);
  });

  it("does not limit Team, investigation billing, or a missing summary", () => {
    expect(invitationsNeedTeamPlan({
      automations: { includesTeammates: true },
      usageBased: true,
    })).toBe(false);
    expect(invitationsNeedTeamPlan({
      automations: { includesTeammates: false },
      usageBased: false,
    })).toBe(false);
    expect(invitationsNeedTeamPlan({ automations: null, usageBased: true })).toBe(false);
  });
});

describe("assertWorkspaceCanInvite", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses an invitation from a workspace on Free or Pro", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const refusal = await assertWorkspaceCanInvite(
      "organization-1",
      dependencies({ includesTeammates: false, usageBased: true }),
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(APIError);
    expect(refusal).toMatchObject({
      body: { code: TEAM_PLAN_REQUIRED },
      status: "FORBIDDEN",
    });
  });

  it("allows an invitation from a workspace on Team", async () => {
    await expect(assertWorkspaceCanInvite(
      "organization-1",
      dependencies({ includesTeammates: true, usageBased: true }),
    )).resolves.toBeUndefined();
  });

  it("does not check the plan of a workspace on investigation billing", async () => {
    const workspace = dependencies({ includesTeammates: false, usageBased: false });

    await expect(assertWorkspaceCanInvite("organization-1", workspace)).resolves.toBeUndefined();
    expect(workspace.getSummary).not.toHaveBeenCalled();
  });

  it("allows the invitation when billing cannot be read", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const workspace = dependencies({ includesTeammates: false, usageBased: true });
    workspace.getSummary.mockRejectedValue(new Error("Autumn unavailable"));

    await expect(assertWorkspaceCanInvite("organization-1", workspace)).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
