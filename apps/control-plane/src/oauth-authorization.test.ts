import { describe, expect, it } from "vitest";
import {
  oauthAuthorizationRequest,
  oauthClientDisplayName,
  oauthErrorMessage,
  oauthNextUrl,
} from "./oauth-authorization";

describe("MCP OAuth page", () => {
  it("reads the client and return host from a signed request", () => {
    expect(
      oauthAuthorizationRequest(
        "?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A6274%2Fcallback&sig=s",
      ),
    ).toEqual({ clientId: "abc", redirectHost: "localhost:6274" });
    expect(
      oauthAuthorizationRequest("?client_id=abc&redirect_uri=cursor%3A%2F%2Fauth&sig=s"),
    ).toEqual({ clientId: "abc", redirectHost: "cursor://auth" });
    expect(
      oauthAuthorizationRequest("?client_id=abc&redirect_uri=vscode%3A%2Fcallback&sig=s"),
    ).toEqual({ clientId: "abc", redirectHost: "vscode" });
  });

  it("treats an unsigned or incomplete request as missing", () => {
    expect(oauthAuthorizationRequest("?client_id=abc")).toBeNull();
    expect(oauthAuthorizationRequest("?sig=s")).toBeNull();
    expect(oauthAuthorizationRequest("")).toBeNull();
  });

  it("names clients that did not register a name", () => {
    expect(oauthClientDisplayName(" Claude Code ")).toBe("Claude Code");
    expect(oauthClientDisplayName("")).toBe("An MCP client");
    expect(oauthClientDisplayName(undefined)).toBe("An MCP client");
  });

  it("reads the next step and errors from the authorization server", () => {
    expect(oauthNextUrl({ redirect: true, url: "http://localhost/cb?code=1" })).toBe(
      "http://localhost/cb?code=1",
    );
    expect(oauthNextUrl({ redirect: true })).toBeNull();
    expect(oauthErrorMessage({ error_description: "invalid redirect uri" })).toBe(
      "invalid redirect uri",
    );
    expect(oauthErrorMessage(null)).toBe(
      "Could not finish connecting. Start again from your MCP client.",
    );
  });
});
