import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  GCP_ACCESS_SCOPES,
  GCP_INVESTIGATION_ROLES,
  GCP_INVESTIGATION_SERVICE_ACCOUNT_ID,
  GCP_REQUIRED_SERVICES,
  GCP_WORKLOAD_IDENTITY_POOL_ID,
  GCP_WORKLOAD_IDENTITY_PROVIDER_ID,
  gcpBrokerIdentity,
  gcpConnectionCredentialsSchema,
  gcpConnectionPrincipalSet,
  gcpInvestigationServiceAccountEmail,
  gcpProjectIdSchema,
  gcpProjectNumberSchema,
  gcpWorkloadIdentityAttributes,
  type GcpConnectionCredentials,
} from "./gcp.js";

// The customer's Google token is used only while Responder creates the
// keyless investigation identity. It is never refreshed or stored with the
// connection, and it is revoked once setup finishes.
const GCP_OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GCP_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GCP_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const RESOURCE_MANAGER_URL = "https://cloudresourcemanager.googleapis.com/v1";
const SERVICE_USAGE_URL = "https://serviceusage.googleapis.com/v1";
const IAM_URL = "https://iam.googleapis.com/v1";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PROJECTS = 1_000;

// Each setup permission, with the predefined role that grants it.
const SETUP_PERMISSION_ROLES = {
  "serviceusage.services.enable": "Service Usage Admin",
  "iam.serviceAccounts.create": "Service Account Admin",
  "iam.serviceAccounts.setIamPolicy": "Service Account Admin",
  "iam.workloadIdentityPools.create": "Workload Identity Pool Admin",
  "iam.workloadIdentityPoolProviders.create": "Workload Identity Pool Admin",
  "resourcemanager.projects.setIamPolicy": "Project IAM Admin",
} as const;
const SETUP_PERMISSIONS = Object.keys(SETUP_PERMISSION_ROLES) as Array<
  keyof typeof SETUP_PERMISSION_ROLES
>;

export const gcpProjectSchema = z.object({
  name: z.string().min(1).max(200),
  projectId: gcpProjectIdSchema,
  projectNumber: gcpProjectNumberSchema,
});

export type GcpProject = z.infer<typeof gcpProjectSchema>;

export type GcpSetupStep =
  | "enabling_apis"
  | "creating_identity_pool"
  | "creating_identity_provider"
  | "granting_access";

export type GcpSetupProgress =
  | { status: "configured" }
  | { status: "pending"; step: GcpSetupStep };

export class GcpSetupError extends Error {
  constructor(
    message: string,
    readonly reason: "permission_denied" | "provider_conflict",
  ) {
    super(message);
    this.name = "GcpSetupError";
  }
}

class GcpApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly googleMessage: string,
  ) {
    super(`Google Cloud returned HTTP ${httpStatus}: ${googleMessage}`);
    this.name = "GcpApiError";
  }
}

function gcpOAuthEnvironment(environment: NodeJS.ProcessEnv): {
  clientId: string;
  clientSecret: string;
} {
  const clientId = environment.GCP_OAUTH_CLIENT_ID;
  const clientSecret = environment.GCP_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google Cloud OAuth is not configured");
  }
  return { clientId, clientSecret };
}

export function createGcpPkce(): { codeChallenge: string; codeVerifier: string } {
  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeChallenge, codeVerifier };
}

export function gcpAuthorizeUrl(
  input: { codeChallenge: string; redirectUri: string; state: string },
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const { clientId } = gcpOAuthEnvironment(environment);
  const url = new URL(GCP_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GCP_ACCESS_SCOPES.join(" "));
  url.searchParams.set("access_type", "online");
  url.searchParams.set("prompt", "select_account consent");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.string(),
});

export async function exchangeGcpOAuthCode(
  input: {
    authorizationCode: string;
    codeVerifier: string;
    fetchImpl?: typeof fetch;
    redirectUri: string;
  },
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ accessToken: string; expiresAt: number }> {
  const { clientId, clientSecret } = gcpOAuthEnvironment(environment);
  const response = await (input.fetchImpl ?? fetch)(GCP_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: input.authorizationCode,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: input.redirectUri,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Google OAuth returned HTTP ${response.status}`);
  }
  const token = tokenResponseSchema.parse(await response.json());
  const grantedScopes = token.scope.split(" ");
  if (!GCP_ACCESS_SCOPES.every((scope) => grantedScopes.includes(scope))) {
    throw new Error("Google OAuth did not grant the Cloud Platform scope");
  }
  return {
    accessToken: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1_000,
  };
}

export async function revokeGcpOAuthToken(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await fetchImpl(GCP_OAUTH_REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: accessToken }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => undefined);
}

async function googleRequest<T>(
  input: {
    accessToken: string;
    body?: unknown;
    fetchImpl: typeof fetch;
    method?: "GET" | "PATCH" | "POST";
    url: string;
  },
): Promise<T> {
  const response = await input.fetchImpl(input.url, {
    method: input.method ?? "GET",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = (await response.json().catch(() => null)) as
    | { error?: { message?: unknown } }
    | null;
  if (!response.ok) {
    const message = typeof payload?.error?.message === "string"
      ? payload.error.message
      : "Unknown error";
    throw new GcpApiError(response.status, message);
  }
  return payload as T;
}

// Creating a resource that a previous round already started returns a
// conflict until Google finishes the long-running operation.
async function googleCreate(
  input: Parameters<typeof googleRequest>[0],
): Promise<void> {
  try {
    await googleRequest(input);
  } catch (error) {
    if (!(error instanceof GcpApiError && error.httpStatus === 409)) throw error;
  }
}

async function googleResource<T>(
  input: Parameters<typeof googleRequest>[0],
): Promise<T | null> {
  try {
    return await googleRequest<T>(input);
  } catch (error) {
    if (error instanceof GcpApiError && error.httpStatus === 404) return null;
    throw error;
  }
}

const projectsPageSchema = z.object({
  nextPageToken: z.string().optional(),
  projects: z.array(z.object({
    name: z.string().optional(),
    projectId: z.string(),
    projectNumber: z.string(),
  })).optional(),
});

export async function listGcpProjects(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GcpProject[]> {
  const projects: GcpProject[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${RESOURCE_MANAGER_URL}/projects`);
    url.searchParams.set("filter", "lifecycleState:ACTIVE");
    url.searchParams.set("pageSize", "500");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = projectsPageSchema.parse(
      await googleRequest({ accessToken, fetchImpl, url: url.toString() }),
    );
    for (const project of page.projects ?? []) {
      // Domain-scoped project IDs ("example.com:name") cannot host the fixed
      // service-account email, so they are not offered.
      const parsed = gcpProjectSchema.safeParse({
        name: project.name || project.projectId,
        projectId: project.projectId,
        projectNumber: project.projectNumber,
      });
      if (parsed.success) projects.push(parsed.data);
    }
    pageToken = page.nextPageToken || undefined;
  } while (pageToken && projects.length < MAX_PROJECTS);
  return projects
    .slice(0, MAX_PROJECTS)
    .sort((left, right) => left.projectId.localeCompare(right.projectId));
}

interface IamBinding {
  condition?: unknown;
  members?: string[];
  role: string;
}

interface IamPolicy {
  bindings?: IamBinding[];
  etag?: string;
  version?: number;
}

function withUnconditionalMember(
  policy: IamPolicy,
  role: string,
  member: string,
): boolean {
  const bindings = policy.bindings ?? [];
  const binding = bindings.find(
    (candidate) => candidate.role === role && !candidate.condition,
  );
  if (binding?.members?.includes(member)) return false;
  if (binding) binding.members = [...(binding.members ?? []), member];
  else bindings.push({ members: [member], role });
  policy.bindings = bindings;
  return true;
}

function isPropagationError(error: unknown): boolean {
  // A just-created service account can be briefly invisible to IAM policy
  // writes, and concurrent policy edits return an etag conflict. Both resolve
  // on the next setup call.
  return error instanceof GcpApiError && (
    error.httpStatus === 404 ||
    error.httpStatus === 409 ||
    (error.httpStatus === 400 && /does not exist/iu.test(error.googleMessage))
  );
}

interface WorkloadIdentityResource {
  aws?: { accountId?: string };
  attributeCondition?: string;
  attributeMapping?: Record<string, string>;
  name: string;
  state?: string;
}

function sameMapping(
  current: Record<string, string> | undefined,
  expected: Record<string, string>,
): boolean {
  const currentEntries = Object.entries(current ?? {});
  return currentEntries.length === Object.keys(expected).length &&
    currentEntries.every(([key, value]) => expected[key] === value);
}

/**
 * Advances the project toward the keyless investigation setup by one bounded
 * round of requests. Every round re-reads Google state, so repeating it after
 * a partial failure or a slow long-running operation is safe.
 */
export async function advanceGcpProjectSetup(input: {
  accessToken: string;
  connection: GcpConnectionCredentials;
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<GcpSetupProgress> {
  const connection = gcpConnectionCredentialsSchema.parse(input.connection);
  const { accountId: brokerAccountId, roleName } = gcpBrokerIdentity(
    input.environment,
  );
  const request = {
    accessToken: input.accessToken,
    fetchImpl: input.fetchImpl ?? fetch,
  };
  const { projectId, projectNumber } = connection;
  const serviceAccountEmail = gcpInvestigationServiceAccountEmail(connection);

  try {
    const granted = await googleRequest<{ permissions?: string[] }>({
      ...request,
      body: { permissions: SETUP_PERMISSIONS },
      method: "POST",
      url: `${RESOURCE_MANAGER_URL}/projects/${projectId}:testIamPermissions`,
    });
    const missing = SETUP_PERMISSIONS.filter(
      (permission) => !granted.permissions?.includes(permission),
    );
    if (missing.length > 0) {
      const roles = [...new Set(missing.map((permission) => SETUP_PERMISSION_ROLES[permission]))];
      throw new GcpSetupError(
        `Your Google account cannot set up access in ${projectId}. Ask a project Owner to connect it, or get the ${roles.join(" and ")} ${roles.length === 1 ? "role" : "roles"} on the project and try again.`,
        "permission_denied",
      );
    }

    const servicesUrl = new URL(
      `${SERVICE_USAGE_URL}/projects/${projectNumber}/services:batchGet`,
    );
    for (const service of GCP_REQUIRED_SERVICES) {
      servicesUrl.searchParams.append(
        "names",
        `projects/${projectNumber}/services/${service}`,
      );
    }
    const services = await googleRequest<{
      services?: Array<{ name?: string; state?: string }>;
    }>({ ...request, url: servicesUrl.toString() });
    const enabled = new Set(
      (services.services ?? [])
        .filter((service) => service.state === "ENABLED")
        .map((service) => service.name?.split("/").at(-1)),
    );
    const disabled = GCP_REQUIRED_SERVICES.filter((service) => !enabled.has(service));
    if (disabled.length > 0) {
      await googleRequest({
        ...request,
        body: { serviceIds: disabled },
        method: "POST",
        url: `${SERVICE_USAGE_URL}/projects/${projectNumber}/services:batchEnable`,
      });
      return { status: "pending", step: "enabling_apis" };
    }

    const serviceAccountUrl =
      `${IAM_URL}/projects/${projectId}/serviceAccounts/${serviceAccountEmail}`;
    if (!(await googleResource({ ...request, url: serviceAccountUrl }))) {
      await googleCreate({
        ...request,
        body: {
          accountId: GCP_INVESTIGATION_SERVICE_ACCOUNT_ID,
          serviceAccount: {
            description:
              "Keyless read-only identity for Responder incident investigations",
            displayName: "Responder investigations",
          },
        },
        method: "POST",
        url: `${IAM_URL}/projects/${projectId}/serviceAccounts`,
      });
    }

    const poolsUrl =
      `${IAM_URL}/projects/${projectNumber}/locations/global/workloadIdentityPools`;
    const pool = await googleResource<WorkloadIdentityResource>({
      ...request,
      url: `${poolsUrl}/${GCP_WORKLOAD_IDENTITY_POOL_ID}`,
    });
    if (!pool) {
      await googleCreate({
        ...request,
        body: {
          description: "Keyless identities used by Responder investigations",
          displayName: "Responder",
        },
        method: "POST",
        url: `${poolsUrl}?workloadIdentityPoolId=${GCP_WORKLOAD_IDENTITY_POOL_ID}`,
      });
      return { status: "pending", step: "creating_identity_pool" };
    }
    if (pool.state === "DELETED") {
      await googleRequest({
        ...request,
        body: {},
        method: "POST",
        url: `${IAM_URL}/${pool.name}:undelete`,
      });
      return { status: "pending", step: "creating_identity_pool" };
    }
    if (pool.state !== "ACTIVE") {
      return { status: "pending", step: "creating_identity_pool" };
    }

    const providerUrl =
      `${poolsUrl}/${GCP_WORKLOAD_IDENTITY_POOL_ID}/providers/${GCP_WORKLOAD_IDENTITY_PROVIDER_ID}`;
    const attributes = gcpWorkloadIdentityAttributes(roleName);
    const provider = await googleResource<WorkloadIdentityResource>({
      ...request,
      url: providerUrl,
    });
    if (!provider) {
      await googleCreate({
        ...request,
        body: {
          ...attributes,
          aws: { accountId: brokerAccountId },
          displayName: "Responder AWS broker",
        },
        method: "POST",
        url: `${poolsUrl}/${GCP_WORKLOAD_IDENTITY_POOL_ID}/providers?workloadIdentityPoolProviderId=${GCP_WORKLOAD_IDENTITY_PROVIDER_ID}`,
      });
      return { status: "pending", step: "creating_identity_provider" };
    }
    if (provider.aws?.accountId !== brokerAccountId) {
      throw new GcpSetupError(
        `The existing ${GCP_WORKLOAD_IDENTITY_PROVIDER_ID} identity provider in ${projectId} trusts a different AWS account.`,
        "provider_conflict",
      );
    }
    if (provider.state === "DELETED") {
      await googleRequest({
        ...request,
        body: {},
        method: "POST",
        url: `${IAM_URL}/${provider.name}:undelete`,
      });
      return { status: "pending", step: "creating_identity_provider" };
    }
    if (provider.state !== "ACTIVE") {
      return { status: "pending", step: "creating_identity_provider" };
    }
    if (
      provider.attributeCondition !== attributes.attributeCondition ||
      !sameMapping(provider.attributeMapping, attributes.attributeMapping)
    ) {
      await googleRequest({
        ...request,
        body: attributes,
        method: "PATCH",
        url: `${providerUrl}?updateMask=attributeMapping,attributeCondition`,
      });
      return { status: "pending", step: "creating_identity_provider" };
    }

    try {
      const serviceAccountPolicy = await googleRequest<IamPolicy>({
        ...request,
        body: {},
        method: "POST",
        url: `${serviceAccountUrl}:getIamPolicy`,
      });
      if (withUnconditionalMember(
        serviceAccountPolicy,
        "roles/iam.workloadIdentityUser",
        gcpConnectionPrincipalSet(connection),
      )) {
        await googleRequest({
          ...request,
          body: { policy: serviceAccountPolicy },
          method: "POST",
          url: `${serviceAccountUrl}:setIamPolicy`,
        });
      }

      const projectPolicy = await googleRequest<IamPolicy>({
        ...request,
        body: { options: { requestedPolicyVersion: 3 } },
        method: "POST",
        url: `${RESOURCE_MANAGER_URL}/projects/${projectId}:getIamPolicy`,
      });
      let projectPolicyChanged = false;
      for (const role of GCP_INVESTIGATION_ROLES) {
        projectPolicyChanged = withUnconditionalMember(
          projectPolicy,
          role,
          `serviceAccount:${serviceAccountEmail}`,
        ) || projectPolicyChanged;
      }
      if (projectPolicyChanged) {
        await googleRequest({
          ...request,
          body: { policy: projectPolicy },
          method: "POST",
          url: `${RESOURCE_MANAGER_URL}/projects/${projectId}:setIamPolicy`,
        });
      }
    } catch (error) {
      if (isPropagationError(error)) {
        return { status: "pending", step: "granting_access" };
      }
      throw error;
    }

    return { status: "configured" };
  } catch (error) {
    if (error instanceof GcpApiError && error.httpStatus === 403) {
      throw new GcpSetupError(
        `Google Cloud denied a setup request in ${projectId}: ${error.googleMessage}`,
        "permission_denied",
      );
    }
    throw error;
  }
}
