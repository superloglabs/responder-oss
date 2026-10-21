import { describe, expect, it } from "vitest";
import { teammatePlan, teamPlanDescription } from "./workspace-settings-presentation";

const pro = { id: "pro", included: 100, includesTeammates: false, machineHours: 50, name: "Pro", price: 100 };
const team = { id: "team", included: 200, includesTeammates: true, machineHours: 500, name: "Team", price: 200 };

describe("Team plan", () => {
  it("is the cheapest plan with teammates", () => {
    const business = { ...team, id: "business", name: "Business", price: 400 };

    expect(teammatePlan({ automations: { plans: [business, pro, team] } })).toEqual(team);
  });

  it("is missing without a plan that includes teammates", () => {
    expect(teammatePlan({ automations: { plans: [pro] } })).toBeNull();
    expect(teammatePlan({ automations: null })).toBeNull();
  });

  it("describes what the plan includes", () => {
    expect(teamPlanDescription(team)).toBe(
      "Your plan includes one seat. Team includes unlimited seats, $200 of usage credit and 500 machine hours each month, for $200 / month.",
    );
    expect(teamPlanDescription(null)).toBe(
      "Your plan includes one seat. Choose a plan with unlimited seats to invite teammates.",
    );
  });
});
