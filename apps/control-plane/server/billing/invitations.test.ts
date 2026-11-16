import { APIError } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationBillingSummary } from "../../../../packages/core/src/billing/autumn.js";
import type { ExtensionSeats } from "../extensions.js";
import {
  assertWorkspaceCanInvite,
  invitationsNeedTeamPlan,
  TEAM_PLAN_REQUIRED,
  workspaceSeats,
} from "./invitations.js";

const signalTeam = { planId: "signal_max", name: "Team", price: 200, included: 100 };

function dependencies(options: {
  includesTeammates: boolean;
  usageBased: boolean;
  extension?: ExtensionSeats;
  unlimitedSeats?: boolean;
}) {
  return {
    getSummary: vi.fn(async () => ({
      includesTeammates: options.includesTeammates,
    }) as AutomationBillingSummary),
    usesUsageBilling: vi.fn(async () => options.usageBased),
    extensionSeats: vi.fn(async () => options.extension ?? { includesTeammates: null, offer: null }),
    hasUnlimitedSeats: vi.fn(async () => options.unlimitedSeats ?? false),
  };
}

describe("workspaceSeats", () => {
  it("offers the extension's Team to a workspace on its one-seat plan", async () => {
    const pro = { includesTeammates: false, offer: signalTeam };
    for (const workspace of [
      dependencies({ includesTeammates: true, usageBased: false, extension: pro }),
      dependencies({ includesTeammates: false, usageBased: true, extension: pro }),
    ]) {
      expect(await workspaceSeats("organization-1", workspace)).toEqual({
        needsTeamPlan: true,
        extensionOffer: signalTeam,
      });
    }
  });

  it("lets any plan with teammates invite", async () => {
    expect(await workspaceSeats("organization-1", dependencies({
      includesTeammates: false,
      usageBased: true,
      extension: { includesTeammates: true, offer: null },
    }))).toEqual({ needsTeamPlan: false, extensionOffer: null });
    expect(await workspaceSeats("organization-1", dependencies({
      includesTeammates: true,
      usageBased: true,
      extension: { includesTeammates: false, offer: signalTeam },
    }))).toEqual({ needsTeamPlan: false, extensionOffer: null });
  });

  it("offers the automation Team when only the automation plan limits", async () => {
    expect(await workspaceSeats("organization-1", dependencies({
      includesTeammates: false,
      usageBased: true,
    }))).toEqual({ needsTeamPlan: true, extensionOffer: null });
  });

  it("never limits a workspace given unlimited seats", async () => {
    const workspace = dependencies({
      includesTeammates: false,
      usageBased: true,
      extension: { includesTeammates: false, offer: signalTeam },
      unlimitedSeats: true,
    });
    expect(await workspaceSeats("organization-1", workspace)).toEqual({
      needsTeamPlan: false,
      extensionOffer: null,
    });
    expect(workspace.extensionSeats).not.toHaveBeenCalled();
  });
});

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

  it("refuses an invitation from a workspace on the extension's one-seat plan", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const refusal = await assertWorkspaceCanInvite(
      "organization-1",
      dependencies({
        includesTeammates: true,
        usageBased: false,
        extension: { includesTeammates: false, offer: signalTeam },
      }),
    ).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ body: { code: TEAM_PLAN_REQUIRED } });
  });

  it("allows the invitation when the extension cannot answer", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const workspace = dependencies({ includesTeammates: false, usageBased: true });
    workspace.extensionSeats.mockRejectedValue(new Error("Extension unavailable"));

    await expect(assertWorkspaceCanInvite("organization-1", workspace)).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it("allows the invitation when billing cannot be read", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const workspace = dependencies({ includesTeammates: false, usageBased: true });
    workspace.getSummary.mockRejectedValue(new Error("Autumn unavailable"));

    await expect(assertWorkspaceCanInvite("organization-1", workspace)).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
