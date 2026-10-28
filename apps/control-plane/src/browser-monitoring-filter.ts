import type { Event, StackFrame } from "@sentry/react";

// Script files we serve ourselves: built chunks in production, source modules in dev.
const APP_SCRIPT_PATH = /\.(?:[cm]?js|jsx|m?ts|tsx)$/i;

/**
 * True when a stack frame points at a script served from our own origin.
 *
 * Frames from `<anonymous>`, `undefined`, browser extensions, other origins,
 * or the HTML document itself are not ours. Our documents contain no inline
 * scripts, so a frame on the page URL comes from code a browser or in-app
 * webview injected into the page.
 */
export function isAppStackFrame(frame: StackFrame, appOrigin: string): boolean {
  if (!frame.filename) return false;
  let url: URL;
  try {
    url = new URL(frame.filename, appOrigin);
  } catch {
    return false;
  }
  return url.origin === appOrigin && APP_SCRIPT_PATH.test(url.pathname);
}

function isUnhandledAbort(event: Event): boolean {
  const exception = event.exception?.values?.at(-1);
  return (
    exception?.type === "AbortError" &&
    (exception.mechanism?.type?.endsWith("onunhandledrejection") ?? false)
  );
}

function hasOnlyForeignFrames(event: Event, appOrigin: string): boolean {
  const frames =
    event.exception?.values?.flatMap((value) => value.stacktrace?.frames ?? []) ?? [];
  // Without frames there is no evidence either way, so keep the event.
  if (frames.length === 0) return false;
  return !frames.some((frame) => isAppStackFrame(frame, appOrigin));
}

/**
 * Decides whether a browser error event is noise we should not report:
 *
 * - errors whose stack has no frame from our own scripts (ad-SDK bridges in
 *   in-app webviews, scripts injected by mobile browsers, extensions)
 * - unhandled rejections from a cancelled request (`AbortError`), which is
 *   how the auth client drops a session fetch it has replaced with a newer one
 */
export function isBrowserNoiseEvent(event: Event, appOrigin: string): boolean {
  return isUnhandledAbort(event) || hasOnlyForeignFrames(event, appOrigin);
}
