import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addSlackReaction,
  postSlackEphemeralMessage,
  postSlackMessage,
  removeSlackReaction,
  setSlackThreadStatus,
  updateSlackMessage,
} from "./slack.js";

describe("Slack delivery client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("adds the eyes reaction", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await addSlackReaction({
      accessToken: "xoxb-test",
      channelId: "C123",
      name: "eyes",
      timestamp: "1785500000.000100",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/reactions.add",
      expect.objectContaining({
        body: JSON.stringify({
          channel: "C123",
          name: "eyes",
          timestamp: "1785500000.000100",
        }),
      }),
    );
  });

  it("posts a reply in the alert thread", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ ok: true, ts: "1785500001.000200" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      postSlackMessage({
        accessToken: "xoxb-test",
        channelId: "C123",
        text: "I’m investigating this alert.",
        threadTimestamp: "1785500000.000100",
      }),
    ).resolves.toBe("1785500001.000200");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        body: JSON.stringify({
          channel: "C123",
          text: "I’m investigating this alert.",
          thread_ts: "1785500000.000100",
        }),
      }),
    );
  });

  it("updates a live investigation card", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await updateSlackMessage({
      accessToken: "xoxb-test",
      blocks: [{ type: "task_card", status: "in_progress" }],
      channelId: "C123",
      text: "Investigating",
      timestamp: "1785500001.000200",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/chat.update",
      expect.objectContaining({
        body: JSON.stringify({
          blocks: [{ type: "task_card", status: "in_progress" }],
          channel: "C123",
          text: "Investigating",
          ts: "1785500001.000200",
        }),
      }),
    );
  });

  it("retains bounded Slack validation diagnostics on API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          error: "invalid_blocks",
          ok: false,
          response_metadata: {
            messages: [
              "[ERROR] must be more than 0 characters [json-pointer:/blocks/0/tasks/1/output]",
            ],
          },
        }),
      ),
    );

    const failure = updateSlackMessage({
      accessToken: "xoxb-test",
      blocks: [{ type: "plan" }],
      channelId: "C123",
      text: "Investigating",
      timestamp: "1785500001.000200",
    });

    await expect(failure).rejects.toMatchObject({
      code: "invalid_blocks",
      diagnostics: [
        "[ERROR] must be more than 0 characters [json-pointer:/blocks/0/tasks/1/output]",
      ],
      method: "chat.update",
    });
  });

  it("sets Slack's native rotating investigation status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await setSlackThreadStatus({
      accessToken: "xoxb-test",
      channelId: "C123",
      loadingMessages: ["Gathering evidence…", "Inspecting source code…"],
      status: "is investigating this alert…",
      threadTimestamp: "1785500000.000100",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/assistant.threads.setStatus",
      expect.objectContaining({
        body: JSON.stringify({
          channel_id: "C123",
          status: "is investigating this alert…",
          thread_ts: "1785500000.000100",
          loading_messages: [
            "Gathering evidence…",
            "Inspecting source code…",
          ],
        }),
      }),
    );
  });

  it("removes the investigating reaction", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await removeSlackReaction({
      accessToken: "xoxb-test",
      channelId: "C123",
      name: "eyes",
      timestamp: "1785500000.000100",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/reactions.remove",
      expect.objectContaining({
        body: JSON.stringify({
          channel: "C123",
          name: "eyes",
          timestamp: "1785500000.000100",
        }),
      }),
    );
  });

  it("posts a markdown prompt as an ephemeral message", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ ok: true, message_ts: "1785500002" }));
    vi.stubGlobal("fetch", fetchMock);

    await postSlackEphemeralMessage({
      accessToken: "xoxb-test",
      blocks: [{ type: "markdown", text: "```markdown\nFix it\n```" }],
      channelId: "C123",
      text: "Investigation prompt",
      userId: "U123",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postEphemeral",
      expect.objectContaining({
        body: JSON.stringify({
          blocks: [{ type: "markdown", text: "```markdown\nFix it\n```" }],
          channel: "C123",
          text: "Investigation prompt",
          user: "U123",
        }),
      }),
    );
  });
});
