import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignIn } from "./auth-gate";

const harness = vi.hoisted(() => ({
  setters: [] as ReturnType<typeof vi.fn>[],
  email: vi.fn(),
  signup: vi.fn(),
  social: vi.fn(),
  pixel: vi.fn(),
  removeItem: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useEffect: () => undefined,
  useState: (initial: unknown) => {
    const setter = vi.fn();
    harness.setters.push(setter);
    return [typeof initial === "function" ? initial() : initial, setter];
  },
}));
vi.mock("../auth-client", () => ({
  authClient: { signIn: { email: harness.email, social: harness.social }, signUp: { email: harness.signup } },
}));
vi.mock("../cells", () => ({ useCellDirectory: () => null }));
vi.mock("../reddit-pixel", () => ({ trackRedditSignupPixel: harness.pixel }));
vi.mock("../x-pixel", () => ({ trackXSignupPixel: vi.fn() }));

function find(node: ReactNode, predicate: (props: Record<string, unknown>, type: unknown) => boolean): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, predicate);
      if (found) return found;
    }
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (predicate(node.props, node.type)) return node.props;
  return find(node.props.children as ReactNode, predicate);
}

function render(signup = false) {
  vi.stubGlobal("window", { location: new URL(`https://example.com/app${signup ? "?signup=1" : ""}`) });
  return SignIn({ allowLegacyHandoff: true });
}

async function submit(signup = false) {
  const form = find(render(signup), (_props, type) => type === "form")!;
  await (form.onSubmit as (event: unknown) => Promise<void>)({ preventDefault: vi.fn(), currentTarget: null });
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.setters = [];
  vi.stubGlobal("sessionStorage", { setItem: vi.fn(), removeItem: harness.removeItem });
  vi.stubGlobal("FormData", class { get(name: string) { return name === "email" ? "test@example.invalid" : "test-password"; } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("sign-in request recovery", () => {
  it("releases the social provider after a rejected request", async () => {
    harness.social.mockRejectedValueOnce(new Error("offline"));
    const button = find(render(), (props, type) => type === "button" && Array.isArray(props.children) && props.children.includes("Continue with Google"))!;
    await (button.onClick as () => Promise<void>)();
    // The click callback starts the request without returning its promise.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.setters[5]).toHaveBeenLastCalledWith(null);
    expect(harness.setters[6]).toHaveBeenLastCalledWith("Could not connect. Please try again.");
  });

  it("records rejected email requests and restores submission", async () => {
    harness.email.mockRejectedValueOnce(new Error("offline"));
    await submit();
    expect(harness.setters[4]).toHaveBeenLastCalledWith(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"event":"email_sign_in_failed"'));
  });

  it("keeps a successful signup successful when tracking throws", async () => {
    harness.signup.mockResolvedValueOnce({ data: { user: { id: "new-user" } } });
    harness.pixel.mockImplementationOnce(() => { throw new Error("tracking unavailable"); });
    await submit(true);
    expect(harness.removeItem).not.toHaveBeenCalled();
    expect(harness.setters[6]).not.toHaveBeenCalledWith("Could not connect. Please try again.");
  });
});
