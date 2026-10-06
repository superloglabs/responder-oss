import { describe, expect, it } from "vitest";
import {
  commitMessageParts,
  conversationAction,
  lineCountLabel,
  pullRequestReference,
  pullRequestTitle,
  shortSha,
} from "./pull-request-presentation";

describe("pull request presentation", () => {
  it("names the repository and number", () => {
    expect(pullRequestReference({ number: 42, repository: "acme/api", url: "https://github.com/acme/api/pull/42" })).toBe("acme/api #42");
  });

  it("reads the repository from the URL when it was not recorded", () => {
    expect(pullRequestReference({ number: 7, repository: null, url: "https://github.com/acme/web/pull/7" })).toBe("acme/web #7");
  });

  it("falls back to a generic title", () => {
    expect(pullRequestTitle({ title: "  " })).toBe("Pull request");
    expect(pullRequestTitle({ title: "Fix login" })).toBe("Fix login");
  });

  it("splits a commit message into its title and description", () => {
    expect(commitMessageParts("Fix login\n\nThe session expired early.\n")).toEqual({
      description: "The session expired early.",
      title: "Fix login",
    });
    expect(commitMessageParts("Fix login")).toEqual({ description: "", title: "Fix login" });
  });

  it("describes comments and reviews", () => {
    const base = { author: null, body: "", createdAt: "2026-10-01T00:00:00Z", id: 1, url: "https://github.com" };
    expect(conversationAction({ ...base, kind: "comment" })).toBe("commented");
    expect(conversationAction({ ...base, comments: [], kind: "review", state: "changes_requested" })).toBe("requested changes");
  });

  it("formats commit hashes and line counts", () => {
    expect(shortSha("0123456789abcdef")).toBe("0123456");
    expect(lineCountLabel(12, 3, 1)).toBe("+12 −3 · 1 file");
  });
});
