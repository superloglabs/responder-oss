// CloudWatch Logs streaming for one AWS connection (ADR 0015).

// "waiting" means the region waits for the customer to update their stack.
export type AwsLogSubscriptionStatus = "active" | "failed" | "pending" | "removing" | "waiting";

export interface AwsLogStreaming {
  available: boolean;
  // Only workspace owners and admins can change regions.
  canManage: boolean;
  // A plain description of what Superlog asks CloudWatch Logs to send.
  filter?: string;
  // Regions where Superlog can receive logs.
  regions: string[];
  // Shown when the stack predates ResponderLogSubscriptionRole.
  stackUpdate: {
    command: string;
    // Opens the stack's update page in AWS. Its template link lasts 15
    // minutes, so the page refreshes it while it waits.
    consoleUrl: string | null;
    logSubscriptionPrincipalArn: string;
    region: string | null;
    stackName: string;
    templateUrl: string | null;
  } | null;
  subscriptions: Array<{
    appliedAt: string | null;
    lastError: string | null;
    region: string;
    status: AwsLogSubscriptionStatus;
  }>;
}

function path(integrationAccountId: string) {
  return `/api/integrations/aws/log-subscriptions/${encodeURIComponent(integrationAccountId)}`;
}

const unavailable: AwsLogStreaming = { available: false, canManage: false, regions: [], stackUpdate: null, subscriptions: [] };

async function read(response: Response, fallback: string): Promise<AwsLogStreaming> {
  const body = (await response.json().catch(() => null)) as (Partial<AwsLogStreaming> & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error ?? fallback);
  // An answer without the fields means no log streaming.
  return {
    available: body.available === true,
    canManage: body.canManage === true,
    filter: body.filter,
    regions: Array.isArray(body.regions) ? body.regions : [],
    stackUpdate: body.stackUpdate ?? null,
    subscriptions: Array.isArray(body.subscriptions) ? body.subscriptions : [],
  };
}

// A server without the route answers 404, which means no log streaming, so
// the page keeps its other CloudWatch setup.
export async function fetchAwsLogStreaming(integrationAccountId: string): Promise<AwsLogStreaming> {
  const response = await fetch(path(integrationAccountId));
  if (response.status === 404) return unavailable;
  return read(response, "Could not load log streaming.");
}

export async function saveAwsLogStreaming(integrationAccountId: string, regions: string[]): Promise<AwsLogStreaming> {
  return read(await fetch(path(integrationAccountId), {
    body: JSON.stringify({ regions }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  }), "Could not save log streaming.");
}

export type AwsLogSubscriptionTone = "danger" | "info" | "live" | "neutral" | "warning";

export const awsLogSubscriptionStatusLabels: Record<AwsLogSubscriptionStatus, { label: string; tone: AwsLogSubscriptionTone }> = {
  active: { label: "Streaming", tone: "live" },
  failed: { label: "Error", tone: "danger" },
  pending: { label: "Setting up", tone: "info" },
  removing: { label: "Removing", tone: "neutral" },
  waiting: { label: "Waiting for the stack update", tone: "warning" },
};
