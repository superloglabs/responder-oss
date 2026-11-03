import { describe, expect, it } from "vitest";
import { decodeReactError } from "./react-errors.js";

const hydration =
  "Minified React error #418; visit https://react.dev/errors/418?args[]=HTML&args[]= for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";

describe("decodeReactError", () => {
  it("expands a production React error into its message with the arguments filled in", () => {
    expect(decodeReactError(hydration)?.split("\n")[0]).toBe(
      "Hydration failed because the server rendered HTML didn't match the client. As a result this tree will be regenerated on the client. This can happen if a SSR-ed Client Component used:",
    );
  });

  it("reads React 18's decoder links and encoded arguments", () => {
    expect(decodeReactError(
      "Minified React error #31; visit https://reactjs.org/docs/error-decoder.html?invariant=31&args[]=object%20with%20keys%20%7Bid%7D for the full message or use the non-minified dev environment for full errors and additional helpful warnings.",
    )).toMatch(/^Objects are not valid as a React child \(found: object with keys \{id\}\)/u);
  });

  it("leaves other messages and unknown codes alone", () => {
    expect(decodeReactError("Cannot read properties of undefined (reading 'id')")).toBeNull();
    expect(decodeReactError("Minified React error #99999; visit https://react.dev/errors/99999 for the full message")).toBeNull();
  });
});
