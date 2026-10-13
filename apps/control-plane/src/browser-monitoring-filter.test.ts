import type { Event } from "@sentry/react";
import { describe, expect, it } from "vitest";
import { isAppStackFrame, isBrowserNoiseEvent } from "./browser-monitoring-filter";

const appOrigin = "https://superlog.sh";

function errorEvent(
  frames: string[],
  { type = "TypeError", mechanism = "auto.browser.global_handlers.onerror" } = {},
): Event {
  return {
    exception: {
      values: [
        {
          mechanism: { handled: false, type: mechanism },
          stacktrace: { frames: frames.map((filename) => ({ filename })) },
          type,
        },
      ],
    },
  };
}

describe("isAppStackFrame", () => {
  it.each([
    "https://superlog.sh/assets/index-LSAnZpwu.js",
    "/assets/index-BkLHDmvb.js",
    "https://superlog.sh/color-theme-init.js",
    "https://superlog.sh/src/pages/agent-create.tsx?t=1",
  ])("treats %s as ours", (filename) => {
    expect(isAppStackFrame({ filename }, appOrigin)).toBe(true);
  });

  it.each([
    "<anonymous>",
    "undefined",
    "[native code]",
    "https://superlog.sh/",
    "https://superlog.sh/agents/new",
    "https://ads.example.com/assets/mraid.js",
    "chrome-extension://abcdef/content.js",
    "webkit-masked-url://hidden/",
  ])("treats %s as foreign", (filename) => {
    expect(isAppStackFrame({ filename }, appOrigin)).toBe(false);
  });

  it("treats a frame without a filename as foreign", () => {
    expect(isAppStackFrame({ function: "Qk" }, appOrigin)).toBe(false);
  });
});

describe("isBrowserNoiseEvent", () => {
  it("drops ad-SDK bridge calls injected by in-app webviews", () => {
    expect(isBrowserNoiseEvent(errorEvent(["<anonymous>"]), appOrigin)).toBe(true);
  });

  it("drops errors from scripts that iOS browsers inject into the page", () => {
    const event = errorEvent([
      "https://superlog.sh/",
      "https://superlog.sh/",
      "https://superlog.sh/",
    ]);
    expect(isBrowserNoiseEvent(event, appOrigin)).toBe(true);
    expect(isBrowserNoiseEvent(errorEvent(["undefined"]), appOrigin)).toBe(true);
  });

  it("keeps errors with at least one frame from our bundle", () => {
    const event = errorEvent([
      "https://superlog.sh/assets/index-LSAnZpwu.js",
      "<anonymous>",
      "https://superlog.sh/assets/index-LSAnZpwu.js",
    ]);
    expect(isBrowserNoiseEvent(event, appOrigin)).toBe(false);
  });

  it("keeps our frames in any linked exception, such as a React error boundary", () => {
    const event: Event = {
      exception: {
        values: [
          { stacktrace: { frames: [{ filename: "<anonymous>" }] }, type: "TypeError" },
          {
            stacktrace: {
              frames: [{ filename: "https://superlog.sh/assets/index-LSAnZpwu.js" }],
            },
            type: "React ErrorBoundary TypeError",
          },
        ],
      },
    };
    expect(isBrowserNoiseEvent(event, appOrigin)).toBe(false);
  });

  it("keeps events that have no stack frames to judge", () => {
    expect(isBrowserNoiseEvent({ message: "Something failed" }, appOrigin)).toBe(false);
    expect(isBrowserNoiseEvent(errorEvent([]), appOrigin)).toBe(false);
  });

  it("drops unhandled rejections from cancelled requests", () => {
    const event = errorEvent(["https://superlog.sh/assets/index-BkLHDmvb.js"], {
      mechanism: "auto.browser.global_handlers.onunhandledrejection",
      type: "AbortError",
    });
    expect(isBrowserNoiseEvent(event, appOrigin)).toBe(true);
  });

  it("keeps AbortErrors we report on purpose and other unhandled rejections", () => {
    const reported = errorEvent(["https://superlog.sh/assets/index-BkLHDmvb.js"], {
      mechanism: "generic",
      type: "AbortError",
    });
    const rejection = errorEvent(["https://superlog.sh/assets/index-BkLHDmvb.js"], {
      mechanism: "auto.browser.global_handlers.onunhandledrejection",
      type: "TypeError",
    });
    expect(isBrowserNoiseEvent(reported, appOrigin)).toBe(false);
    expect(isBrowserNoiseEvent(rejection, appOrigin)).toBe(false);
  });
});
