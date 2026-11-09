// CloudWatch Logs streaming for one AWS connection (ADR 0015).

export type AwsLogSubscriptionStatus = "active" | "failed" | "pending" | "removing";

export interface AwsLogStreaming {
  available: boolean;
  // A plain description of what Superlog asks CloudWatch Logs to send.
  filter?: string;
  // Regions where Superlog can receive logs.
  regions: string[];
  // Shown when the stack predates ResponderLogSubscriptionRole.
  stackUpdate: {
    command: string;
    logSubscriptionPrincipalArn: string;
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

async function read(response: Response, fallback: string): Promise<AwsLogStreaming> {
  const body = (await response.json().catch(() => null)) as (Partial<AwsLogStreaming> & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error ?? fallback);
  // An answer without the fields, such as from an older server, means no
  // log streaming.
  return {
    available: body.available === true,
    filter: body.filter,
    regions: Array.isArray(body.regions) ? body.regions : [],
    stackUpdate: body.stackUpdate ?? null,
    subscriptions: Array.isArray(body.subscriptions) ? body.subscriptions : [],
  };
}

export async function fetchAwsLogStreaming(integrationAccountId: string): Promise<AwsLogStreaming> {
  return read(await fetch(path(integrationAccountId)), "Could not load log streaming.");
}

export async function saveAwsLogStreaming(integrationAccountId: string, regions: string[]): Promise<AwsLogStreaming> {
  return read(await fetch(path(integrationAccountId), {
    body: JSON.stringify({ regions }),
    headers: { "content-type": "application/json" },
    method: "PUT",
  }), "Could not save log streaming.");
}

export const awsLogSubscriptionStatusLabels: Record<AwsLogSubscriptionStatus, { label: string; tone: "danger" | "info" | "live" | "neutral" }> = {
  active: { label: "Streaming", tone: "live" },
  failed: { label: "Error", tone: "danger" },
  pending: { label: "Starting", tone: "info" },
  removing: { label: "Stopping", tone: "neutral" },
};
