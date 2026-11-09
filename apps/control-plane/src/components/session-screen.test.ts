import { describe, expect, it } from "vitest";
import { sessionScreen } from "./session-screen";

const user = { id: "user-1" };

describe("sessionScreen", () => {
  it("shows the loading screen until the first session check succeeds", () => {
    expect(
      sessionScreen({ data: null, error: null, isPending: true }, false),
    ).toBe("loading");
  });

  it("shows the unavailable screen when the first session check fails", () => {
    expect(
      sessionScreen({ data: null, error: new Error("down"), isPending: false }, false),
    ).toBe("unavailable");
  });

  it("keeps the sign-in form while a signed-out session refetches", () => {
    expect(
      sessionScreen({ data: null, error: null, isPending: true }, true),
    ).toBe("signedOut");
  });

  it("keeps the sign-in form when a later refetch fails", () => {
    expect(
      sessionScreen({ data: null, error: new Error("down"), isPending: false }, true),
    ).toBe("signedOut");
  });

  it("keeps a signed-in visitor in the app when a later refetch fails", () => {
    expect(
      sessionScreen({ data: user, error: new Error("down"), isPending: false }, true),
    ).toBe("signedIn");
  });
});
