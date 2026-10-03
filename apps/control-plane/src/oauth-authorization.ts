// The authorization server sends people to /oauth/authorize with the MCP
// client's request in a signed query. These helpers read the parts the page
// shows; the server checks the signature when the page continues the flow.

export interface OAuthAuthorizationRequest {
  clientId: string;
  redirectHost: string | null;
}

export function oauthAuthorizationRequest(
  search: string,
): OAuthAuthorizationRequest | null {
  const params = new URLSearchParams(search);
  const clientId = params.get("client_id");
  if (!clientId || !params.has("sig")) return null;
  return { clientId, redirectHost: redirectHost(params.get("redirect_uri")) };
}

function redirectHost(redirectUri: string | null): string | null {
  if (!redirectUri) return null;
  try {
    const url = new URL(redirectUri);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.host
      : url.protocol.replace(/:$/, "");
  } catch {
    return null;
  }
}

export function oauthClientDisplayName(name: unknown): string {
  return typeof name === "string" && name.trim() ? name.trim() : "An MCP client";
}

// The consent and continue endpoints answer with the next URL instead of a
// redirect, because the page calls them with fetch.
export function oauthNextUrl(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const url = (body as { url?: unknown }).url;
  return typeof url === "string" && url ? url : null;
}

export function oauthErrorMessage(body: unknown): string {
  if (typeof body === "object" && body !== null) {
    const { error_description: description, message } = body as {
      error_description?: unknown;
      message?: unknown;
    };
    if (typeof description === "string" && description) return description;
    if (typeof message === "string" && message) return message;
  }
  return "Could not finish connecting. Start again from your MCP client.";
}
