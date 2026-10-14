const remoteShellMaxAgeMs = 60_000;
const remoteShellRetryMs = 5_000;
const remoteShellTimeoutMs = 3_000;

// The shell has a head for preview tags and the element the application
// mounts in. Anything else, such as an error page, is not cached.
function isAppShell(html: string): boolean {
  return html.includes("</head>") && html.includes('<div id="root"></div>');
}

// Fetches /app.html from the public address of a deployment that serves the
// build from a CDN, and reuses it for a minute. Requests that arrive together
// share one fetch. A failed fetch keeps the last shell and waits five seconds
// before the next try; null means no shell has loaded yet.
function remoteShellLoader(options: {
  baseUrl: () => string;
  fetchRemote: (url: string, init: RequestInit) => Promise<Response>;
  now: () => number;
}): () => Promise<string | null> {
  let remote: { fetchedAt: number; html: string } | undefined;
  let refreshing: Promise<string | null> | undefined;
  let retryAt = 0;

  async function refresh(): Promise<string | null> {
    try {
      const response = await options.fetchRemote(
        new URL("/app.html", options.baseUrl()).toString(),
        { signal: AbortSignal.timeout(remoteShellTimeoutMs) },
      );
      const html = response.ok && response.headers.get("content-type")?.startsWith("text/html")
        ? await response.text()
        : null;
      if (html && isAppShell(html)) {
        remote = { fetchedAt: options.now(), html };
        return html;
      }
    } catch {
      // Keep the last shell below.
    }
    retryAt = options.now() + remoteShellRetryMs;
    return remote?.html ?? null;
  }

  return () => {
    const time = options.now();
    if (remote && time - remote.fetchedAt < remoteShellMaxAgeMs) {
      return Promise.resolve(remote.html);
    }
    if (time < retryAt) return Promise.resolve(remote?.html ?? null);
    refreshing ??= refresh().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };
}

// Loads the application shell for documents the server renders itself.
// Self-hosted servers read it from their build. Without a local build, the
// shell comes from the deployment's CDN.
export function appShellLoader(options: {
  baseUrl: () => string;
  fetchRemote?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  readLocal: () => Promise<string>;
}): () => Promise<string | null> {
  const local = options.readLocal().catch(() => null);
  let loadRemote: (() => Promise<string | null>) | undefined;
  return async () => {
    const html = await local;
    if (html !== null) return html;
    loadRemote ??= remoteShellLoader({
      baseUrl: options.baseUrl,
      fetchRemote: options.fetchRemote ?? fetch,
      now: options.now ?? Date.now,
    });
    return loadRemote();
  };
}
