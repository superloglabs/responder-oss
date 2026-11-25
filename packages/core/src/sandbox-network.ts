import { z } from "zod";

// A workspace's sandboxes either have open outbound access or reach only an
// allowlist, which is the default. Superlog's own host, which serves the model
// broker and context servers, and each mounted secret's hosts are always on
// that list, so a run keeps working however short the workspace's list is.

export interface SandboxNetworkSettings {
  restricted: boolean;
  allowedDomains: string[];
}

// The list a workspace starts with: package registries, their installers and
// CDNs, Debian's package mirrors, and GitHub, so agents can install tools and
// dependencies and read public code. OpenCode also installs its model
// provider package from npm when a run starts, and a Daytona sandbox without a
// snapshot installs its tools with apt and Bun's installer.
export const defaultSandboxAllowedDomains = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "nodejs.org",
  "unpkg.com",
  "cdn.jsdelivr.net",
  "pypi.org",
  "files.pythonhosted.org",
  "bootstrap.pypa.io",
  "astral.sh",
  "bun.sh",
  "proxy.golang.org",
  "sum.golang.org",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "rubygems.org",
  "repo.maven.apache.org",
  "repo1.maven.org",
  "jsr.io",
  "deb.debian.org",
  "security.debian.org",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "*.githubusercontent.com",
];

export const defaultSandboxNetworkSettings: SandboxNetworkSettings = {
  restricted: true,
  allowedDomains: defaultSandboxAllowedDomains,
};

// Daytona accepts up to 100 domains in all, Superlog's host and the secrets'
// hosts included. Nothing limits the secrets' hosts, so a run whose list grows
// past that fails on Daytona and says so.
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
    .transform((domains) => [...new Set(domains)])
    .refine(
      (domains) => domains.length <= maxSandboxAllowedDomains,
      `Add at most ${maxSandboxAllowedDomains} domains`,
    ),
});

// The public application URL, which serves the model broker and context
// servers. A blank setting counts as unset.
export function publicApplicationUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return [
    environment.RESPONDER_PUBLIC_URL,
    environment.RESPONDER_APP_URL,
    environment.BETTER_AUTH_URL,
  ].map((value) => value?.trim()).find(Boolean);
}

// The paths under the public application URL that serve the model broker and
// the context servers.
export const automationModelBrokerPath = "/api/automation-model-broker";
export const automationContextBrokerPath = "/api/automation-context-broker";

// The domains a restricted sandbox reaches, or null for open access.
// `*.example.com` covers example.com and every subdomain. On Superlog's own
// host a sandbox reaches only the brokers, and only with its run's token.
export interface SandboxNetwork {
  allowedDomains: string[];
  application: {
    // An RE2 pattern for the broker paths. Dot segments and percent-encoding
    // are left out, so a path cannot resolve to another route.
    brokerPathPattern: string;
    host: string;
  };
  brokerToken?: string;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function sandboxNetworkFor(
  settings: SandboxNetworkSettings,
  applicationUrl: string,
): SandboxNetwork | null {
  if (!settings.restricted) return null;
  const url = new URL(applicationUrl);
  const brokers = [automationModelBrokerPath, automationContextBrokerPath]
    .map((path) => escapeRegularExpression(`${url.pathname.replace(/\/$/u, "")}${path}`));
  return {
    allowedDomains: [...new Set([url.hostname, ...settings.allowedDomains])],
    application: {
      brokerPathPattern: `^(?:${brokers.join("|")})/(?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*/?)*(?:\\?.*)?$`,
      host: url.hostname,
    },
  };
}

// Adds the hosts of the secrets mounted in the sandbox, which a secret needs
// to be of any use.
export function sandboxAllowedDomains(
  network: Pick<SandboxNetwork, "allowedDomains">,
  secrets: ReadonlyArray<{ allowedHosts?: string[] }>,
): string[] {
  return [...new Set([
    ...network.allowedDomains,
    ...secrets.flatMap((secret) => secret.allowedHosts ?? []),
  ])];
}
