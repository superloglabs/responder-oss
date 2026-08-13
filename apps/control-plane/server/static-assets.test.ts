import { describe, expect, it } from "vitest";
import { isSourceMapPath } from "./static-assets.js";

describe("production static assets", () => {
  it.each(["/assets/application.js.map", "/assets/STYLES.CSS.MAP"])(
    "blocks source maps: %s",
    (pathname) => {
      expect(isSourceMapPath(pathname)).toBe(true);
    },
  );

  it.each(["/assets/application.js", "/settings"])(
    "allows ordinary paths: %s",
    (pathname) => {
      expect(isSourceMapPath(pathname)).toBe(false);
    },
  );
});
