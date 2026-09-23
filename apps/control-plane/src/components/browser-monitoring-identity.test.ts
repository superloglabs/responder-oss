import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserMonitoringIdentity } from "./browser-monitoring-identity";

const mocks = vi.hoisted(() => ({
  organization: { data: null as null | { id: string; name: string } },
  refetch: vi.fn().mockResolvedValue(undefined),
  setIdentity: vi.fn(),
  session: { data: { user: { id: "user-1", name: "Ada" }, session: { id: "session-1", activeOrganizationId: "org-1" } }, isPending: false },
}));
vi.mock("react", () => ({ useEffect: (effect: () => void) => effect() }));
vi.mock("../auth-client", () => ({ authClient: {
  useSession: () => mocks.session,
  useActiveOrganization: () => ({ ...mocks.organization, refetch: mocks.refetch }),
} }));
vi.mock("../browser-monitoring", () => ({ setBrowserMonitoringIdentity: mocks.setIdentity }));

describe("monitoring after sign-in with a restored organization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.organization.data = null;
    mocks.refetch.mockResolvedValue(undefined);
  });

  it("sets the organization name when the refreshed response arrives", async () => {
    mocks.refetch.mockImplementationOnce(async () => {
      mocks.organization.data = { id: "org-1", name: "Acme" };
    });
    BrowserMonitoringIdentity();
    await Promise.resolve();
    BrowserMonitoringIdentity();
    expect(mocks.setIdentity).toHaveBeenLastCalledWith("user-1", "org-1", "Ada", "Acme");
  });

  it("does not report a cached name for another organization", () => {
    mocks.organization.data = { id: "old-org", name: "Old workspace" };
    BrowserMonitoringIdentity();
    expect(mocks.setIdentity).toHaveBeenLastCalledWith("user-1", "org-1", "Ada", undefined);
  });

  it("keeps identity reporting working when the refresh rejects", async () => {
    mocks.refetch.mockRejectedValueOnce(new Error("Network unavailable"));
    BrowserMonitoringIdentity();
    await Promise.resolve();
    expect(mocks.setIdentity).toHaveBeenCalledWith("user-1", "org-1", "Ada", undefined);
  });
  it("refreshes the organization even when its cached response is null", () => {
    BrowserMonitoringIdentity();
    expect(mocks.refetch).toHaveBeenCalledOnce();
    expect(mocks.setIdentity).toHaveBeenCalledWith("user-1", "org-1", "Ada", undefined);
  });
});
