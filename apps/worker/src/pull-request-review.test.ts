import { describe, expect, it, vi } from "vitest";
import { reviewPullRequest } from "./pull-request-review.js";

const target = { installationId: 456, number: 7, repository: "acme/web" };

function dependencies(response: Response) {
  return {
    createInstallationToken: vi.fn().mockResolvedValue("installation-token"),
    fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
  };
}

describe("pull request review", () => {
  it("posts a comment-only review with inline comments", async () => {
    const deps = dependencies(new Response(JSON.stringify({
      html_url: "https://github.com/acme/web/pull/7#pullrequestreview-99",
      id: 99,
    })));

    const result = await reviewPullRequest({
      body: "Two observability gaps.",
      comments: [
        { body: "Log the error.", line: 12, path: "src/charge.ts" },
        { body: "This catch hides failures.", line: 30, path: "src/sync.ts", side: "RIGHT", startLine: 26 },
      ],
      target,
    }, deps);

    expect(result).toEqual({
      comments: 2,
      reviewId: 99,
      url: "https://github.com/acme/web/pull/7#pullrequestreview-99",
    });
    expect(deps.createInstallationToken).toHaveBeenCalledWith(456);
    const [url, init] = deps.fetch.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/acme/web/pulls/7/reviews");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      body: "Two observability gaps.",
      comments: [
        { body: "Log the error.", line: 12, path: "src/charge.ts", side: "RIGHT" },
        { body: "This catch hides failures.", line: 30, path: "src/sync.ts", side: "RIGHT", start_line: 26, start_side: "RIGHT" },
      ],
      event: "COMMENT",
    });
  });

  it("names the line GitHub could not place", async () => {
    const deps = dependencies(new Response(JSON.stringify({
      errors: ["Line could not be resolved"],
      message: "Unprocessable Entity",
    }), { status: 422 }));

    await expect(reviewPullRequest({
      body: "One gap.",
      comments: [{ body: "Log it.", line: 999, path: "src/charge.ts" }],
      target,
    }, deps)).rejects.toThrow("Unprocessable Entity: Line could not be resolved");
  });
});
