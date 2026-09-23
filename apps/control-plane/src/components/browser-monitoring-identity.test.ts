import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserMonitoringIdentity } from "./browser-monitoring-identity";

const mocks = vi.hoisted(() => ({
  refetch: vi.fn().mockResolvedValue(undefined),
  setIdentity: vi.fn(),
  session: { data: { user: { id: "user-1", name: "Ada" }, session: { id: "session-1", activeOrganizationId: "org-1" } }, isPending: false },
}));
vi.mock("react", () => ({ useEffect: (effect: () => void) => effect() }));
vi.mock("../auth-client", () => ({ authClient: {
  useSession: () => mocks.session,
  useActiveOrganization: () => ({ data: null, refetch: mocks.refetch }),
} }));
vi.mock("../browser-monitoring", () => ({ setBrowserMonitoringIdentity: mocks.setIdentity }));

describe("monitoring after sign-in with a restored organization", () => {
  beforeEach(() => vi.clearAllMocks());
  it("refreshes the organization even when its cached response is null", () => {
    BrowserMonitoringIdentity();
    expect(mocks.refetch).toHaveBeenCalledOnce();
    expect(mocks.setIdentity).toHaveBeenCalledWith("user-1", "org-1", "Ada", undefined);
  });
});
