const remoteShellMaxAgeMs = 60_000;
const remoteShellTimeoutMs = 3_000;

// Loads the application shell for documents the server renders itself.
// Self-hosted servers read it from their build. A deployment that serves the
// build from a CDN has no local copy, so the server fetches /app.html from its
// public address and reuses it for a minute. A failed refresh keeps the last
// shell; null means no shell has loaded yet.
export function appShellLoader(options: {
  baseUrl: () => string;
  fetchRemote?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  readLocal: () => Promise<string>;
}): () => Promise<string | null> {
  const fetchRemote = options.fetchRemote ?? fetch;
  const now = options.now ?? Date.now;
  let local: Promise<string | null> | undefined;
  let remote: { fetchedAt: number; html: string } | undefined;

  async function refresh(): Promise<string | null> {
    try {
      const response = await fetchRemote(
        new URL("/app.html", options.baseUrl()).toString(),
        { signal: AbortSignal.timeout(remoteShellTimeoutMs) },
      );
      if (!response.ok) return remote?.html ?? null;
      remote = { fetchedAt: now(), html: await response.text() };
      return remote.html;
    } catch {
      return remote?.html ?? null;
    }
  }

  return async () => {
    local ??= options.readLocal().catch(() => null);
    const html = await local;
    if (html !== null) return html;
    if (remote && now() - remote.fetchedAt < remoteShellMaxAgeMs) {
      return remote.html;
    }
    return refresh();
  };
}
