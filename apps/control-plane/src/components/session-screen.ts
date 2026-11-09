import { useState } from "react";

export type SessionScreen = "loading" | "unavailable" | "signedOut" | "signedIn";

type SessionState = {
  data: unknown;
  error: unknown;
  isPending: boolean;
};

// Better Auth refetches the session when the tab becomes visible again. While
// it does, a signed-out session is marked pending, and a failed refetch sets
// an error. Swapping the sign-in form for the loading or unavailable screen
// then would unmount it and clear what was typed, so those screens show only
// until the first session check succeeds.
export function sessionScreen(
  session: SessionState,
  loaded: boolean,
): SessionScreen {
  if (!loaded) {
    if (session.isPending) return "loading";
    if (session.error) return "unavailable";
  }
  return session.data ? "signedIn" : "signedOut";
}

export function useSessionScreen(session: SessionState): SessionScreen {
  const [loaded, setLoaded] = useState(false);
  const succeeded = !session.isPending && !session.error;
  if (succeeded && !loaded) setLoaded(true);
  return sessionScreen(session, loaded || succeeded);
}
