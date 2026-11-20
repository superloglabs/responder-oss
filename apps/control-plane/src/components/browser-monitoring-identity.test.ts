import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserMonitoringIdentity } from "./browser-monitoring-identity";

const signedIn = { user: { id: "user-1", name: "Ada" }, session: { id: "session-1", activeOrganizationId: "org-1" } };
const mocks = vi.hoisted(() => ({
  organization: { data: null as null | { id: string; name: string } },
  organizationRequests: vi.fn(),
  refetch: vi.fn().mockResolvedValue(undefined),
  setIdentity: vi.fn(),
  session: { data: null as null | typeof signedIn, isPending: false },
}));
vi.mock("react", () => ({ useEffect: (effect: () => void) => effect() }));
vi.mock("../auth-client", () => ({ authClient: {
  useSession: () => mocks.session,
  useActiveOrganization: () => {
    mocks.organizationRequests();
    return { ...mocks.organization, refetch: mocks.refetch };
  },
} }));
vi.mock("../browser-monitoring", () => ({
  setBrowserMonitoringIdentity: mocks.setIdentity,
}));

// Renders the component and the organization child it returns, without React.
function render() {
  const element = BrowserMonitoringIdentity() as ReactElement<object, (props: object) => ReactNode> | null;
  element?.type(element.props);
}

describe("monitoring a signed-out visitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.data = null;
  });

  it("does not request an organization", () => {
    render();
    expect(mocks.organizationRequests).not.toHaveBeenCalled();
    expect(mocks.refetch).not.toHaveBeenCalled();
    expect(mocks.setIdentity).toHaveBeenCalledWith(undefined, undefined, undefined, undefined);
  });
});

describe("monitoring after sign-in with a restored organization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.data = signedIn;
    mocks.organization.data = null;
    mocks.refetch.mockResolvedValue(undefined);
  });

  it("sets the organization name when the refreshed response arrives", async () => {
    mocks.refetch.mockImplementationOnce(async () => {
      mocks.organization.data = { id: "org-1", name: "Acme" };
    });
    render();
    await Promise.resolve();
    render();
    expect(mocks.setIdentity).toHaveBeenLastCalledWith("user-1", "org-1", "Ada", "Acme");
  });

  it("does not report a cached name for another organization", () => {
    mocks.organization.data = { id: "old-org", name: "Old workspace" };
    render();
    expect(mocks.setIdentity).toHaveBeenLastCalledWith("user-1", "org-1", "Ada", undefined);
  });

  it("keeps identity reporting working when the refresh rejects", async () => {
    mocks.refetch.mockRejectedValueOnce(new Error("Network unavailable"));
    render();
    await Promise.resolve();
    expect(mocks.setIdentity).toHaveBeenCalledWith("user-1", "org-1", "Ada", undefined);
  });
  it("refreshes the organization even when its cached response is null", () => {
    render();
    expect(mocks.refetch).toHaveBeenCalledOnce();
    expect(mocks.setIdentity).toHaveBeenCalledWith("user-1", "org-1", "Ada", undefined);
  });
});
