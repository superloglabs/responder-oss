import { describe, expect, it, vi } from "vitest";
import { appShellLoader } from "./app-shell.js";

const missing = () => Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
const page = (body: string) => new Response(`<html><head></head><body><div id="root"></div>${body}</body></html>`, { headers: { "content-type": "text/html" }, status: 200 });
const shell = (body: string) => `<html><head></head><body><div id="root"></div>${body}</body></html>`;

describe("application shell", () => {
  it("reads the local build once when it exists", async () => {
    const readLocal = vi.fn(() => Promise.resolve("<html>local</html>"));
    const fetchRemote = vi.fn();
    const load = appShellLoader({ baseUrl: () => "https://superlog.sh", fetchRemote, readLocal });

    await expect(load()).resolves.toBe("<html>local</html>");
    await expect(load()).resolves.toBe("<html>local</html>");
    expect(readLocal).toHaveBeenCalledTimes(1);
    expect(fetchRemote).not.toHaveBeenCalled();
  });

  it("fetches the shell from the public address without a local build", async () => {
    const fetchRemote = vi.fn(() => Promise.resolve(page("cdn")));
    const load = appShellLoader({ baseUrl: () => "https://superlog.sh", fetchRemote, readLocal: missing });

    await expect(load()).resolves.toBe(shell("cdn"));
    expect(fetchRemote).toHaveBeenCalledWith("https://superlog.sh/app.html", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("keeps a fetched shell for a minute, then fetches the current one", async () => {
    let time = 0;
    const fetchRemote = vi.fn()
      .mockResolvedValueOnce(page("first"))
      .mockResolvedValueOnce(page("second"));
    const load = appShellLoader({ baseUrl: () => "https://superlog.sh", fetchRemote, now: () => time, readLocal: missing });

    await expect(load()).resolves.toBe(shell("first"));
    time = 59_000;
    await expect(load()).resolves.toBe(shell("first"));
    time = 61_000;
    await expect(load()).resolves.toBe(shell("second"));
    expect(fetchRemote).toHaveBeenCalledTimes(2);
  });

  it("ignores a response that is not the application shell", async () => {
    let time = 0;
    const fetchRemote = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { headers: { "content-type": "application/json" }, status: 200 }))
      .mockResolvedValueOnce(new Response("<html><body>Not found</body></html>", { headers: { "content-type": "text/html" }, status: 200 }));
    const load = appShellLoader({ baseUrl: () => "https://superlog.sh", fetchRemote, now: () => time, readLocal: missing });

    await expect(load()).resolves.toBeNull();
    time = 5_000;
    await expect(load()).resolves.toBeNull();
    expect(fetchRemote).toHaveBeenCalledTimes(2);
  });

  it("serves the last shell when a fetch fails, and nothing before any succeeds", async () => {
    let time = 0;
    const fetchRemote = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(page("first"))
      .mockRejectedValueOnce(new Error("timeout"));
    const load = appShellLoader({ baseUrl: () => "https://superlog.sh", fetchRemote, now: () => time, readLocal: missing });

    await expect(load()).resolves.toBeNull();
    time = 5_000;
    await expect(load()).resolves.toBe(shell("first"));
    time = 66_000;
    await expect(load()).resolves.toBe(shell("first"));
  });

  it("shares one fetch between requests that arrive together", async () => {
    const fetchRemote = vi.fn(() => Promise.resolve(page("cdn")));
    const load = appShellLoader({ baseUrl: () => "https://superlog.sh", fetchRemote, readLocal: missing });

    await expect(Promise.all([load(), load(), load()])).resolves.toEqual([shell("cdn"), shell("cdn"), shell("cdn")]);
    expect(fetchRemote).toHaveBeenCalledTimes(1);
  });

  it("waits five seconds after a failed fetch before trying again", async () => {
    let time = 0;
    const fetchRemote = vi.fn()
      .mockResolvedValueOnce(page("first"))
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(page("second"));
    const load = appShellLoader({ baseUrl: () => "https://superlog.sh", fetchRemote, now: () => time, readLocal: missing });

    await load();
    time = 61_000;
    await expect(load()).resolves.toBe(shell("first"));
    time = 65_000;
    await expect(load()).resolves.toBe(shell("first"));
    expect(fetchRemote).toHaveBeenCalledTimes(2);
    time = 66_000;
    await expect(load()).resolves.toBe(shell("second"));
  });
});
