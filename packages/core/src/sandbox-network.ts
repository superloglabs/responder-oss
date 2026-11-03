import { z } from "zod";

// A workspace's sandboxes either have open outbound access or reach only an
// allowlist. Superlog's own host, which serves the model broker and context
// servers, and each mounted secret's hosts are always on that list, so a run
// keeps working however short the workspace's list is.

export interface SandboxNetworkSettings {
  restricted: boolean;
  allowedDomains: string[];
}

export const defaultSandboxNetworkSettings: SandboxNetworkSettings = {
  restricted: false,
  allowedDomains: [],
};

// Daytona accepts up to 100 domains in all, and the rest of the list holds
// Superlog's host and the secrets' hosts.
export const maxSandboxAllowedDomains = 50;

export const sandboxDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .regex(
    /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u,
    "Use a domain such as registry.npmjs.org or *.example.com, without a scheme, path, or port",
  );

export const sandboxNetworkSettingsSchema = z.object({
  restricted: z.boolean(),
  allowedDomains: z
    .array(sandboxDomainSchema)
    .max(maxSandboxAllowedDomains, `Add at most ${maxSandboxAllowedDomains} domains`)
    .transform((domains) => [...new Set(domains)]),
});

// The domains a restricted sandbox reaches, or null for open access.
// `*.example.com` covers example.com and every subdomain.
export interface SandboxNetwork {
  allowedDomains: string[];
}

export function sandboxNetworkFor(
  settings: SandboxNetworkSettings,
  applicationUrl: string,
): SandboxNetwork | null {
  if (!settings.restricted) return null;
  return {
    allowedDomains: [...new Set([new URL(applicationUrl).hostname, ...settings.allowedDomains])],
  };
}

// Adds the hosts of the secrets mounted in the sandbox, which a secret needs
// to be of any use.
export function sandboxAllowedDomains(
  network: SandboxNetwork,
  secrets: ReadonlyArray<{ allowedHosts?: string[] }>,
): string[] {
  return [...new Set([
    ...network.allowedDomains,
    ...secrets.flatMap((secret) => secret.allowedHosts ?? []),
  ])];
}
