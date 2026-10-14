const remoteShellMaxAgeMs = 60_000;
const remoteShellTimeoutMs = 3_000;

// The shell has a head for preview tags and the element the application
// mounts in. Anything else, such as an error page, is not cached.
function isAppShell(html: string): boolean {
  return html.includes("</head>") && html.includes('<div id="root"></div>');
}

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
      const html = response.ok && response.headers.get("content-type")?.startsWith("text/html")
        ? await response.text()
        : null;
      if (!html || !isAppShell(html)) return remote?.html ?? null;
      remote = { fetchedAt: now(), html };
      return html;
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
