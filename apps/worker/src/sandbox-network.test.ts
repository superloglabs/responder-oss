import { describe, expect, it, vi } from "vitest";
import { workspaceSandboxNetwork } from "./sandbox-network.js";

describe("workspaceSandboxNetwork", () => {
  it("is null for a workspace with open access", async () => {
    const load = vi.fn().mockResolvedValue({ allowedDomains: ["example.com"], restricted: false });
    await expect(workspaceSandboxNetwork("org-1", {}, load)).resolves.toBeNull();
    expect(load).toHaveBeenCalledWith("org-1");
  });

  it("adds the public application host to a restricted workspace's list", async () => {
    const load = vi.fn().mockResolvedValue({ allowedDomains: ["registry.npmjs.org"], restricted: true });
    await expect(workspaceSandboxNetwork("org-1", { RESPONDER_PUBLIC_URL: "https://superlog.sh" }, load))
      .resolves.toEqual({ allowedDomains: ["superlog.sh", "registry.npmjs.org"] });
  });

  it("refuses to restrict a sandbox without a public application URL", async () => {
    const load = vi.fn().mockResolvedValue({ allowedDomains: [], restricted: true });
    await expect(workspaceSandboxNetwork("org-1", {}, load)).rejects.toThrow("A public application URL is required");
  });
});
