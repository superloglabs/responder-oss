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
        clientMessageId: "16161616-1616-4616-8616-161616161616",
        text: "I’m investigating this alert.",
        threadTimestamp: "1785500000.000100",
      }),
    ).resolves.toBe("1785500001.000200");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postMessage",
      expect.objectContaining({
        body: JSON.stringify({
          channel: "C123",
          client_msg_id: "16161616-1616-4616-8616-161616161616",
          text: "I’m investigating this alert.",
          thread_ts: "1785500000.000100",
        }),
      }),
    );
  });

  it("retries an ambiguous post response with the same client message ID", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("upstream response was not JSON", {
          headers: { "content-type": "text/plain" },
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ ok: true, ts: "1785500001.000200" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = postSlackMessage({
      accessToken: "xoxb-test",
      channelId: "C123",
      clientMessageId: "16161616-1616-4616-8616-161616161616",
      text: "Investigation result",
      threadTimestamp: "1785500000.000100",
    });
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toBe("1785500001.000200");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(fetchMock.mock.calls[0]?.[1]);
  });

  it("accepts successful posts with unexpected optional response fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        errors: "unexpected but irrelevant on success",
        ok: true,
        response_metadata: null,
        ts: "1785500001.000200",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      postSlackMessage({
        accessToken: "xoxb-test",
        channelId: "C123",
        clientMessageId: "16161616-1616-4616-8616-161616161616",
        text: "Investigation result",
      }),
    ).resolves.toBe("1785500001.000200");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps bounded metadata when Slack returns invalid JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("not JSON and not safe to log verbatim", {
          headers: { "content-type": "text/plain; charset=utf-8" },
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const failure = postSlackMessage({
      accessToken: "xoxb-test",
      channelId: "C123",
      text: "Investigation result",
    });

    await expect(failure).rejects.toMatchObject({
      code: "http_200",
      diagnostics: [
        "Slack returned invalid JSON (status=200, content-type=text/plain; charset=utf-8, bytes=37); body=not JSON and not safe to log verbatim",
      ],
      method: "chat.postMessage",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a deterministic Slack rejection", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        error: "invalid_blocks",
        ok: false,
        response_metadata: {
          messages: ["A block is invalid"],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const failure = postSlackMessage({
      accessToken: "xoxb-test",
      blocks: [{ type: "section" }],
      channelId: "C123",
      clientMessageId: "16161616-1616-4616-8616-161616161616",
      text: "Investigation result",
    });

    await expect(failure).rejects.toMatchObject({ code: "invalid_blocks" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps schema paths when Slack returns an invalid response shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ok: "yes", ts: 123 })),
    );

    const failure = postSlackMessage({
      accessToken: "xoxb-test",
      channelId: "C123",
      text: "Investigation result",
    });

    await expect(failure).rejects.toMatchObject({
      code: "http_200",
      diagnostics: [
        expect.stringContaining("invalid response shape"),
        "Invalid field ok (invalid_type)",
      ],
      method: "chat.postMessage",
    });
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
      threadTimestamp: "1785500000.000100",
      userId: "U123",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://slack.com/api/chat.postEphemeral",
      expect.objectContaining({
        body: JSON.stringify({
          blocks: [{ type: "markdown", text: "```markdown\nFix it\n```" }],
          channel: "C123",
          text: "Investigation prompt",
          thread_ts: "1785500000.000100",
          user: "U123",
        }),
      }),
    );
  });
});
