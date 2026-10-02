import { describe, expect, it } from "vitest";
import {
  advanceGcpProjectSetup,
  exchangeGcpOAuthCode,
  gcpAuthorizeUrl,
  GcpSetupError,
  listGcpProjects,
} from "./gcp-setup.js";

const environment = {
  AWS_INTEGRATION_PRINCIPAL_ARN:
    "arn:aws:iam::111122223333:role/ResponderAwsIntegrationBroker",
  GCP_OAUTH_CLIENT_ID: "client-id.apps.googleusercontent.com",
  GCP_OAUTH_CLIENT_SECRET: "client-secret",
};

const connection = {
  projectId: "konex-prod",
  projectNumber: "123456789012",
  sessionName: "responder-gcp-abcdefghijklmnopqrstuvwxyz123456",
};

const serviceAccount =
  "responder-investigation@konex-prod.iam.gserviceaccount.com";
const poolPath =
  "projects/123456789012/locations/global/workloadIdentityPools/responder";

interface Policy {
  bindings: Array<{ condition?: unknown; members: string[]; role: string }>;
  etag: string;
  version: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function googleError(status: number, message: string): Response {
  return json({ error: { code: status, message } }, status);
}

// A small in-memory model of the Google APIs that setup touches. Pools and
// providers become active one call after creation to mimic long-running
// operations.
function fakeGoogle(options: {
  missingPermissions?: string[];
  poolCreationPending?: boolean;
  providerAccountId?: string;
  serviceAccountPolicyMisses?: number;
} = {}) {
  const enabled = new Set<string>(["logging.googleapis.com"]);
  let serviceAccountExists = false;
  let pool: { name: string; state: string } | null = null;
  let provider: Record<string, unknown> | null = options.providerAccountId
    ? {
        attributeCondition: "attribute.aws_role == 'Other'",
        attributeMapping: {},
        aws: { accountId: options.providerAccountId },
        name: `${poolPath}/providers/responder-aws`,
        state: "ACTIVE",
      }
    : null;
  let serviceAccountPolicyMisses = options.serviceAccountPolicyMisses ?? 0;
  const serviceAccountPolicy: Policy = { bindings: [], etag: "a", version: 1 };
  const projectPolicy: Policy = {
    bindings: [
      { members: ["user:owner@glowtify.com"], role: "roles/owner" },
      {
        condition: { expression: "request.time < timestamp('2030-01-01')" },
        members: ["user:contractor@glowtify.com"],
        role: "roles/logging.viewer",
      },
    ],
    etag: "b",
    version: 3,
  };
  const writes: string[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = `${url.host}${url.pathname}`;
    if (method !== "GET") writes.push(`${method} ${path}`);

    if (path.endsWith("/projects/konex-prod:testIamPermissions")) {
      return json({
        permissions: (body.permissions as string[]).filter(
          (permission) => !options.missingPermissions?.includes(permission),
        ),
      });
    }
    if (path.endsWith("/services:batchGet")) {
      return json({
        services: url.searchParams.getAll("names").map((name) => ({
          name,
          state: enabled.has(name.split("/").at(-1)!) ? "ENABLED" : "DISABLED",
        })),
      });
    }
    if (path.endsWith("/services:batchEnable")) {
      for (const service of body.serviceIds as string[]) enabled.add(service);
      return json({ name: "operations/enable" });
    }
    if (path.endsWith(`/serviceAccounts/${serviceAccount}`) && method === "GET") {
      return serviceAccountExists
        ? json({ email: serviceAccount })
        : googleError(404, "Not found");
    }
    if (path.endsWith("/projects/konex-prod/serviceAccounts") && method === "POST") {
      serviceAccountExists = true;
      return json({ email: serviceAccount });
    }
    if (path.endsWith(`/${poolPath}`) && method === "GET") {
      if (!pool) return googleError(404, "Pool not found");
      const current = { ...pool };
      pool.state = "ACTIVE";
      return json(current);
    }
    if (path.endsWith("/workloadIdentityPools") && method === "POST") {
      if (pool || options.poolCreationPending) {
        return googleError(409, "Requested entity already exists");
      }
      pool = { name: poolPath, state: "CREATING" };
      return json({ name: "operations/pool" });
    }
    if (path.endsWith(`/${poolPath}/providers/responder-aws`) && method === "GET") {
      if (!provider) return googleError(404, "Provider not found");
      const current = { ...provider };
      provider.state = "ACTIVE";
      return json(current);
    }
    if (path.endsWith(`/${poolPath}/providers`) && method === "POST") {
      provider = { ...body, name: `${poolPath}/providers/responder-aws`, state: "CREATING" };
      return json({ name: "operations/provider" });
    }
    if (path.endsWith(`/${poolPath}/providers/responder-aws`) && method === "PATCH") {
      provider = { ...provider, ...body };
      return json({ name: "operations/provider-update" });
    }
    if (path.endsWith(`/serviceAccounts/${serviceAccount}:getIamPolicy`)) {
      if (serviceAccountPolicyMisses > 0) {
        serviceAccountPolicyMisses -= 1;
        return googleError(404, "Service account not found");
      }
      return json(structuredClone(serviceAccountPolicy));
    }
    if (path.endsWith(`/serviceAccounts/${serviceAccount}:setIamPolicy`)) {
      serviceAccountPolicy.bindings = body.policy.bindings;
      return json(body.policy);
    }
    if (path.endsWith("/projects/konex-prod:getIamPolicy")) {
      expect(body).toEqual({ options: { requestedPolicyVersion: 3 } });
      return json(structuredClone(projectPolicy));
    }
    if (path.endsWith("/projects/konex-prod:setIamPolicy")) {
      expect(body.policy.version).toBe(3);
      projectPolicy.bindings = body.policy.bindings;
      return json(body.policy);
    }
    throw new Error(`Unexpected Google request: ${method} ${url}`);
  }) as typeof fetch;

  return { fetchImpl, projectPolicy, serviceAccountPolicy, writes };
}

async function runSetup(fetchImpl: typeof fetch) {
  const steps: string[] = [];
  for (let round = 0; round < 10; round += 1) {
    const progress = await advanceGcpProjectSetup({
      accessToken: "user-token",
      connection,
      environment,
      fetchImpl,
    });
    if (progress.status === "configured") return steps;
    steps.push(progress.step);
  }
  throw new Error("Setup did not converge");
}

describe("Google Cloud OAuth setup", () => {
  it("requests a one-time Cloud Platform authorization with PKCE", () => {
    const url = new URL(gcpAuthorizeUrl(
      {
        codeChallenge: "challenge",
        redirectUri: "https://responder.example/api/integrations/gcp/callback",
        state: "state",
      },
      environment,
    ));
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      access_type: "online",
      client_id: environment.GCP_OAUTH_CLIENT_ID,
      code_challenge: "challenge",
      code_challenge_method: "S256",
      scope: "https://www.googleapis.com/auth/cloud-platform",
      state: "state",
    });
  });

  it("rejects an authorization that did not grant Cloud Platform access", async () => {
    const fetchImpl = (async () => json({
      access_token: "token",
      expires_in: 3599,
      scope: "openid",
      token_type: "Bearer",
    })) as typeof fetch;
    await expect(exchangeGcpOAuthCode(
      {
        authorizationCode: "code",
        codeVerifier: "verifier",
        fetchImpl,
        redirectUri: "https://responder.example/api/integrations/gcp/callback",
      },
      environment,
    )).rejects.toThrow("Cloud Platform scope");
  });

  it("lists active projects across pages and skips domain-scoped IDs", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requested.push(url.searchParams.get("pageToken") ?? "");
      expect(url.searchParams.get("filter")).toBe("lifecycleState:ACTIVE");
      return url.searchParams.get("pageToken")
        ? json({
            projects: [
              { name: "Konex", projectId: "konex-prod", projectNumber: "123456789012" },
            ],
          })
        : json({
            nextPageToken: "next",
            projects: [
              { projectId: "example.com:legacy", projectNumber: "222222222222" },
              { projectId: "glowtify-staging", projectNumber: "333333333333" },
            ],
          });
    }) as typeof fetch;

    await expect(listGcpProjects("token", fetchImpl)).resolves.toEqual([
      { name: "glowtify-staging", projectId: "glowtify-staging", projectNumber: "333333333333" },
      { name: "Konex", projectId: "konex-prod", projectNumber: "123456789012" },
    ]);
    expect(requested).toEqual(["", "next"]);
  });

  it("creates the keyless read-only identity step by step and is then a no-op", async () => {
    const google = fakeGoogle();

    await expect(runSetup(google.fetchImpl)).resolves.toEqual([
      "enabling_apis",
      "creating_identity_pool",
      "creating_identity_pool",
      "creating_identity_provider",
      "creating_identity_provider",
    ]);

    expect(google.serviceAccountPolicy.bindings).toEqual([{
      members: [
        `principalSet://iam.googleapis.com/${poolPath}/attribute.responder_connection/${connection.sessionName}`,
      ],
      role: "roles/iam.workloadIdentityUser",
    }]);
    const member = `serviceAccount:${serviceAccount}`;
    const rolesForServiceAccount = google.projectPolicy.bindings
      .filter((binding) => binding.members.includes(member))
      .map((binding) => binding.role);
    expect(rolesForServiceAccount.sort()).toEqual([
      "roles/cloudasset.viewer",
      "roles/logging.viewer",
      "roles/mcp.toolUser",
      "roles/monitoring.viewer",
      "roles/serviceusage.serviceUsageConsumer",
    ]);
    expect(rolesForServiceAccount).not.toContain("roles/owner");
    // The conditional binding is preserved, and the grant is unconditional.
    expect(google.projectPolicy.bindings).toContainEqual(expect.objectContaining({
      condition: expect.anything(),
      members: ["user:contractor@glowtify.com"],
    }));

    google.writes.length = 0;
    await expect(runSetup(google.fetchImpl)).resolves.toEqual([]);
    expect(google.writes.filter((write) => !write.endsWith(":testIamPermissions") &&
      !write.endsWith(":getIamPolicy"))).toEqual([]);
  });

  it("keeps waiting while Google is still creating the identity pool", async () => {
    const google = fakeGoogle({ poolCreationPending: true });
    for (let round = 0; round < 3; round += 1) {
      await expect(advanceGcpProjectSetup({
        accessToken: "user-token",
        connection,
        environment,
        fetchImpl: google.fetchImpl,
      })).resolves.toMatchObject({ status: "pending" });
    }
  });

  it("waits while a new service account is not yet visible to IAM", async () => {
    const google = fakeGoogle({ serviceAccountPolicyMisses: 1 });
    const steps = await runSetup(google.fetchImpl);
    expect(steps.at(-1)).toBe("granting_access");
  });

  it("stops before any change when the account cannot grant access", async () => {
    const google = fakeGoogle({
      missingPermissions: ["resourcemanager.projects.setIamPolicy"],
    });
    const setup = advanceGcpProjectSetup({
      accessToken: "user-token",
      connection,
      environment,
      fetchImpl: google.fetchImpl,
    });
    await expect(setup).rejects.toBeInstanceOf(GcpSetupError);
    await expect(setup).rejects.toMatchObject({ reason: "permission_denied" });
    await expect(setup).rejects.toThrow(
      "Your Google account cannot set up access in konex-prod. Ask a project Owner to connect it, or get the Project IAM Admin role on the project and try again.",
    );
    expect(google.writes).toEqual([
      "POST cloudresourcemanager.googleapis.com/v1/projects/konex-prod:testIamPermissions",
    ]);
  });

  it("names each role that grants the missing permissions once", async () => {
    const google = fakeGoogle({
      missingPermissions: [
        "iam.serviceAccounts.setIamPolicy",
        "iam.workloadIdentityPools.create",
        "iam.workloadIdentityPoolProviders.create",
      ],
    });
    await expect(runSetup(google.fetchImpl)).rejects.toThrow(
      "or get the Service Account Admin and Workload Identity Pool Admin roles on the project",
    );
  });

  it("refuses to repoint a provider that trusts another AWS account", async () => {
    const google = fakeGoogle({ providerAccountId: "999999999999" });
    await expect(runSetup(google.fetchImpl)).rejects.toMatchObject({
      reason: "provider_conflict",
    });
    expect(google.writes.some((write) => write.startsWith("PATCH"))).toBe(false);
  });
});
