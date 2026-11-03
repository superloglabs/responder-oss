import { getSandboxNetworkSettings } from "@responder/core/db/sandbox-network";
import { sandboxNetworkFor, type SandboxNetwork } from "@responder/core/sandbox-network";

// The outbound allowlist for a workspace's sandboxes, or null for open
// access. Superlog's public host is on it because the model broker and the
// context servers are served there.
export async function workspaceSandboxNetwork(
  organizationId: string,
  environment: NodeJS.ProcessEnv = process.env,
  load: typeof getSandboxNetworkSettings = getSandboxNetworkSettings,
): Promise<SandboxNetwork | null> {
  const settings = await load(organizationId);
  if (!settings.restricted) return null;
  const applicationUrl = environment.RESPONDER_PUBLIC_URL ??
    environment.RESPONDER_APP_URL ??
    environment.BETTER_AUTH_URL;
  if (!applicationUrl) {
    throw new Error("A public application URL is required for a restricted sandbox");
  }
  return sandboxNetworkFor(settings, applicationUrl);
}
