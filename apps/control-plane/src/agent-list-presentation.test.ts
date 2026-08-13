import { describe, expect, it } from "vitest";
import type { AgentListItem } from "./agents-api";
import {
  agentMatchesFilter,
  agentRunStatus,
  integrationsForAgent,
} from "./agent-list-presentation";

const agent: AgentListItem = {
  activeVersionId: "version-1",
  description: "Investigates production incidents",
  enabled: true,
  id: "agent-1",
  latestRun: {
    agentId: "agent-1",
    createdAt: "2026-08-03T12:00:00.000Z",
    status: "investigating",
  },
  name: "Production responder",
  prMode: "manual",
  reportConfig: {
    integrationAccountId: "slack-1",
    mode: "output_channel",
    outputChannelId: "channel-1",
  },
  repositoryCount: 2,
  trigger: "sentry_issue",
  triggerConfig: {},
  updatedAt: "2026-08-03T12:00:00.000Z",
};

describe("agent list presentation", () => {
  it("summarizes integrations without duplicate Slack entries", () => {
    expect(integrationsForAgent(agent)).toEqual(["Sentry", "Slack", "GitHub"]);
  });

  it("presents run and enabled state independently", () => {
    expect(agentRunStatus(agent)).toBe("Investigating");
    expect(agentMatchesFilter(agent, "active")).toBe(true);
    expect(agentMatchesFilter(agent, "paused")).toBe(false);
  });
});
