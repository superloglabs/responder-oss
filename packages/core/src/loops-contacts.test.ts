import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncLoopsSignupContact } from "./loops-contacts.js";

const fetchMock = vi.fn();

describe("Loops signup contacts", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("is disabled when the API key is absent", async () => {
    await syncLoopsSignupContact({ email: "user@example.com", name: "Ada" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("upserts the contact by email with the split name", async () => {
    vi.stubEnv("LOOPS_API_KEY", " loops-key ");

    await syncLoopsSignupContact({
      email: " Ada@Example.COM ",
      name: " Ada  King Lovelace ",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://app.loops.so/api/v1/contacts/update");
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({
      Authorization: "Bearer loops-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "King Lovelace",
      source: "Responder",
      userGroup: "Users",
    });
  });

  it("omits name fields when the account has no name", async () => {
    vi.stubEnv("LOOPS_API_KEY", "loops-key");

    await syncLoopsSignupContact({ email: "user@example.com", name: " " });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      email: "user@example.com",
      source: "Responder",
      userGroup: "Users",
    });
  });

  it("logs delivery failures without throwing", async () => {
    vi.stubEnv("LOOPS_API_KEY", "loops-key");
    fetchMock.mockResolvedValue(new Response(null, { status: 400 }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      syncLoopsSignupContact({ email: "user@example.com" }),
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      "Unable to add signup to Loops: Loops API responded with status 400",
    );
  });

  it("logs network errors without throwing", async () => {
    vi.stubEnv("LOOPS_API_KEY", "loops-key");
    fetchMock.mockRejectedValue(new Error("network down"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await syncLoopsSignupContact({ email: "user@example.com" });

    expect(consoleError).toHaveBeenCalledWith(
      "Unable to add signup to Loops: network down",
    );
  });
});
