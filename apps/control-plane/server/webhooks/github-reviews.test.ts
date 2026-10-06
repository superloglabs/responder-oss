import { describe, expect, it, vi } from "vitest";
import type { PullRequestReviewTarget } from "@responder/core/db/pull-request-origins";
import {
  pullRequestReviewMessage,
  startPullRequestReviewTurn,
  type PullRequestReviewComment,
  type PullRequestReviewEvent,
} from "./github-reviews.js";

vi.mock("../automations/queue.js", () => ({ queueAutomationRunReply: vi.fn() }));
vi.mock("../investigations/queue.js", () => ({ queueSlackThreadInvestigation: vi.fn() }));
vi.mock("@responder/core/db/pull-request-origins", () => ({
  admitBotReviewTurn: vi.fn(),
  findPullRequestReviewTarget: vi.fn(),
}));

function reviewEvent(overrides: {
  action?: string;
  association?: string;
  body?: string;
  login?: string;
  type?: string;
} = {}): PullRequestReviewEvent {
  return {
    action: overrides.action ?? "submitted",
    installation: { id: 789 },
    pull_request: { html_url: "https://github.com/acme/api/pull/42", number: 42 },
    repository: { full_name: "acme/api" },
    review: {
      author_association: overrides.association ?? "NONE",
      body: overrides.body ?? "",
      html_url: "https://github.com/acme/api/pull/42#pullrequestreview-5",
      id: 5,
      state: "commented",
      user: {
        login: overrides.login ?? "greptile-apps[bot]",
        type: overrides.type ?? "Bot",
      },
    },
  };
}

const comment: PullRequestReviewComment = {
  body: "New test always fails: the query references the catalog twice.",
  html_url: "https://github.com/acme/api/pull/42#discussion_r123",
  id: 123,
  line: 26,
  path: "tests/test_schema.py",
};

const automationTarget: PullRequestReviewTarget = {
  automationRun: { automationEnabled: true, id: "run-1" },
  id: "origin-1",
  organizationId: "organization-1",
  thread: null,
};

const threadTarget: PullRequestReviewTarget = {
  automationRun: null,
  id: "origin-2",
  organizationId: "organization-1",
  thread: {
    agentId: "agent-1",
    channelId: "C123",
    id: "session-1",
    latestInput: {
      attributes: {
        channelId: "C123",
        integrationAccountId: "account-1",
        slackAssistant: true,
        slackEventId: "Ev1",
        slackUserId: "U1",
        teamId: "T1",
        threadTimestamp: "1700000000.000100",
        timestamp: "1700000000.000500",
      },
      body: "Fix the schema reads",
      externalEventId: "slack:Ev1",
      provider: "slack",
      title: "Fix the schema reads",
    },
    teamId: "T1",
    threadTimestamp: "1700000000.000100",
  },
};

function dependencies(target: PullRequestReviewTarget | null = automationTarget) {
  return {
    admitBotReviewTurn: vi.fn().mockResolvedValue(true),
    findTarget: vi.fn().mockResolvedValue(target),
    listComments: vi.fn().mockResolvedValue([comment]),
    queueAutomationRunReply: vi.fn().mockResolvedValue("queued"),
    queueThreadTurn: vi.fn().mockResolvedValue({
      investigationId: "investigation-2",
      jobId: "job-1",
      kind: "queued",
    }),
  };
}

const environment = { GITHUB_APP_SLUG: "superlog-responder" } as NodeJS.ProcessEnv;

describe("pull request review turns", () => {
  it("continues the automation run that opened the pull request", async () => {
    const deps = dependencies();

    await expect(startPullRequestReviewTurn(reviewEvent(), deps, environment)).resolves.toBe("queued");

    expect(deps.queueAutomationRunReply).toHaveBeenCalledWith({
      message: {
        authorId: "greptile-apps[bot]",
        authorName: "greptile-apps[bot]",
        externalEventId: "github-review:5",
        githubReview: {
          pullRequestNumber: 42,
          repository: "acme/api",
          reviewUrl: "https://github.com/acme/api/pull/42#pullrequestreview-5",
        },
        source: "github",
        text: pullRequestReviewMessage(reviewEvent(), [comment]),
      },
      runId: "run-1",
    });
  });

  it("starts a turn in the thread that opened the pull request, answering in the same place", async () => {
    const deps = dependencies(threadTarget);

    await expect(startPullRequestReviewTurn(reviewEvent(), deps, environment)).resolves.toBe("queued");

    expect(deps.queueThreadTurn).toHaveBeenCalledWith(
      {
        agentId: "agent-1",
        attributes: {
          channelId: "C123",
          githubPullRequestNumber: 42,
          githubRepository: "acme/api",
          githubReviewUrl: "https://github.com/acme/api/pull/42#pullrequestreview-5",
          integrationAccountId: "account-1",
          slackAssistant: true,
          teamId: "T1",
          threadTimestamp: "1700000000.000100",
          timestamp: "1700000000.000100",
        },
        body: pullRequestReviewMessage(reviewEvent(), [comment]),
        externalEventId: "github-review:5",
        provider: "slack",
        sourceUrl: "https://github.com/acme/api/pull/42#pullrequestreview-5",
        title: "Review on acme/api#42",
      },
      { channelId: "C123", teamId: "T1", threadTimestamp: "1700000000.000100" },
    );
  });

  it("ignores reviews the app posted itself", async () => {
    const deps = dependencies();

    await expect(startPullRequestReviewTurn(
      reviewEvent({ login: "superlog-responder[bot]" }),
      deps,
      environment,
    )).resolves.toBe("ignored");
    expect(deps.findTarget).not.toHaveBeenCalled();
  });

  it("ignores people who cannot push to the repository", async () => {
    const deps = dependencies();

    await expect(startPullRequestReviewTurn(
      reviewEvent({ association: "CONTRIBUTOR", login: "stranger", type: "User" }),
      deps,
      environment,
    )).resolves.toBe("ignored");
    expect(deps.findTarget).not.toHaveBeenCalled();
  });

  it("answers members without counting toward the bot limit", async () => {
    const deps = dependencies();

    await expect(startPullRequestReviewTurn(
      reviewEvent({ association: "MEMBER", body: "Please also rename the helper.", login: "ash", type: "User" }),
      deps,
      environment,
    )).resolves.toBe("queued");
    expect(deps.admitBotReviewTurn).not.toHaveBeenCalled();
  });

  it("stops answering a bot once the pull request used its bot turns", async () => {
    const deps = dependencies();
    deps.admitBotReviewTurn.mockResolvedValue(false);

    await expect(startPullRequestReviewTurn(reviewEvent(), deps, environment)).resolves.toBe("bot_limit_reached");
    expect(deps.queueAutomationRunReply).not.toHaveBeenCalled();
  });

  it("ignores pull requests Responder did not open from a thread or run", async () => {
    const deps = dependencies(null);

    await expect(startPullRequestReviewTurn(reviewEvent(), deps, environment)).resolves.toBe("not_ours");
    expect(deps.listComments).not.toHaveBeenCalled();
  });

  it("ignores an empty review and edits or dismissals", async () => {
    const deps = dependencies();
    deps.listComments.mockResolvedValue([]);

    await expect(startPullRequestReviewTurn(reviewEvent(), deps, environment)).resolves.toBe("ignored");
    await expect(startPullRequestReviewTurn(reviewEvent({ action: "dismissed" }), deps, environment)).resolves.toBe("ignored");
    expect(deps.admitBotReviewTurn).not.toHaveBeenCalled();
    expect(deps.queueAutomationRunReply).not.toHaveBeenCalled();
  });

  it("ignores a review for an automation that was turned off", async () => {
    const deps = dependencies({
      ...automationTarget,
      automationRun: { automationEnabled: false, id: "run-1" },
    });

    await expect(startPullRequestReviewTurn(reviewEvent(), deps, environment)).resolves.toBe("ignored");
    expect(deps.queueAutomationRunReply).not.toHaveBeenCalled();
  });

  it("lists every comment with its ID and location", () => {
    expect(pullRequestReviewMessage(
      reviewEvent({ body: "Two problems." }),
      [comment, { ...comment, id: 124, in_reply_to_id: 123, line: null, original_line: 30 }],
    )).toBe([
      "greptile-apps[bot] (a bot) reviewed pull request #42 in acme/api, which you opened: https://github.com/acme/api/pull/42#pullrequestreview-5",
      "",
      "Review:",
      "Two problems.",
      "",
      "Comments:",
      "- Comment 123 on tests/test_schema.py line 26:",
      "New test always fails: the query references the catalog twice.",
      "- Comment 124 (a reply to comment 123) on tests/test_schema.py line 30:",
      "New test always fails: the query references the catalog twice.",
    ].join("\n"));
  });
});
