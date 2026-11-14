import { z } from "zod";
import { decryptCredentials } from "../credentials/encryption.js";
import { getConnectedIntegrationAccountCredential } from "../db/integrations.js";
import {
  claimSlackConnectChannel,
  getOrganizationName,
  getUserEmail,
  updateSlackConnectChannel,
  type SlackConnectChannel,
  type SlackConnectChannelStatus,
} from "../db/slack-connect-channels.js";

// When a workspace connects Slack, Superlog shares a channel named
// `<workspace>-superlog` between the operator's Slack and the workspace's.
//
// The operator's bot creates the channel and invites the workspace's Slack
// app, which accepts the invitation and adds the member who connected Slack.
// When the workspace's Slack app cannot accept, the member is sent a Slack
// Connect invitation by email instead.

// Scopes the workspace's Slack app needs to accept the invitation and add the
// member to the channel.
export const slackConnectCustomerScopes = [
  "channels:write.invites",
  "conversations.connect:write",
] as const;

export type SlackConnectConfig = {
  // Bot token of a Slack app installed in the operator's Slack, with the
  // channels:manage, channels:write.invites and conversations.connect:write
  // scopes.
  hostToken: string;
  // Operator members added to every new channel.
  hostUserIds: string[];
};

export function slackConnectConfig(
  env: NodeJS.ProcessEnv = process.env,
): SlackConnectConfig | null {
  const hostToken = env.SLACK_CONNECT_HOST_TOKEN?.trim();
  if (!hostToken) return null;
  const hostUserIds = (env.SLACK_CONNECT_HOST_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return { hostToken, hostUserIds };
}

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack ${method} failed: ${code}`);
  }
}

export type SlackCall = (
  token: string,
  method: string,
  body: Record<string, string>,
) => Promise<Record<string, unknown>>;

export const callSlack: SlackCall = async (token, method, body) => {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (
    !payload ||
    typeof payload !== "object" ||
    !("ok" in payload) ||
    payload.ok !== true
  ) {
    const code =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : `http_${response.status}`;
    throw new SlackApiError(method, code);
  }
  return payload as Record<string, unknown>;
};

const slackChannelNameLimit = 80;

// Slack channel names are lowercase letters, digits, hyphens and underscores,
// up to 80 characters.
export function slackConnectChannelName(companyName: string, attempt = 0): string {
  const suffix = attempt > 0 ? `-superlog-${attempt + 1}` : "-superlog";
  const base =
    companyName
      .normalize("NFKD")
      .replace(/[̀-ͯ]/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "workspace";
  return `${base.slice(0, slackChannelNameLimit - suffix.length).replace(/-+$/u, "")}${suffix}`;
}

export type SlackConnectInstallation = {
  accessToken: string;
  botUserId: string;
  scopes: string[];
};

export type SlackConnectJobInput = {
  integrationAccountId: string;
  organizationId: string;
  // The Slack user who connected Slack, in the workspace's Slack.
  slackUserId: string;
  // The Superlog member who connected Slack.
  userId: string;
};

export type SlackConnectDeps = {
  call: SlackCall;
  claim: (organizationId: string) => Promise<
    Pick<SlackConnectChannel, "channelId" | "channelName" | "status">
  >;
  config: SlackConnectConfig | null;
  installation: (
    integrationAccountId: string,
  ) => Promise<SlackConnectInstallation | null>;
  log: (event: string, fields: Record<string, unknown>) => void;
  organizationName: (organizationId: string) => Promise<string | null>;
  update: (
    organizationId: string,
    patch: Partial<
      Pick<SlackConnectChannel, "channelId" | "channelName" | "lastError" | "status">
    >,
  ) => Promise<void>;
  userEmail: (userId: string) => Promise<string | null>;
};

export type SlackConnectOutcome = "disabled" | SlackConnectChannelStatus;

// Slack errors worth retrying the job for.
const transientSlackErrors = new Set([
  "fatal_error",
  "internal_error",
  "ratelimited",
  "request_timeout",
  "service_unavailable",
]);

function isTransient(error: unknown): boolean {
  if (!(error instanceof SlackApiError)) return true;
  return transientSlackErrors.has(error.code) || error.code.startsWith("http_");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const channelNameAttempts = 10;

// Shares the workspace's channel. Safe to run again: each run continues from
// the stored status, and a retried job finishes adding the member once the
// channel is approved.
export async function connectSlackWorkspace(
  input: SlackConnectJobInput,
  deps: SlackConnectDeps,
): Promise<SlackConnectOutcome> {
  const { config } = deps;
  if (!config) return "disabled";

  const { organizationId } = input;
  const row = await deps.claim(organizationId);
  if (row.status === "failed" || row.status === "invited" || row.status === "joined") {
    return row.status;
  }

  const installation = await deps.installation(input.integrationAccountId);
  let { channelId, channelName } = row;
  if (!channelId || !channelName) {
    const companyName = (await deps.organizationName(organizationId)) ?? "workspace";
    ({ channelId, channelName } = await createHostChannel(config, deps.call, companyName));
    await deps.update(organizationId, { channelId, channelName });
    await addHostMembers(config, deps, channelId);
  }

  if (row.status === "pending") {
    const accepted =
      installation &&
      slackConnectCustomerScopes.every((scope) => installation.scopes.includes(scope))
        ? await shareWithApp(config, deps, installation, channelId, channelName).then(
            () => true,
            (error: unknown) => {
              deps.log("slack_connect_app_share_failed", {
                error: errorMessage(error),
                organizationId,
              });
              return false;
            },
          )
        : false;
    if (!accepted) {
      return inviteByEmail(config, deps, input, channelId);
    }
    await deps.update(organizationId, { lastError: null, status: "accepted" });
  }

  // The workspace's app joined the channel; add the member who connected
  // Slack. Until an admin approves the channel this fails, and the job is
  // retried.
  if (!installation) return "accepted";
  try {
    await deps.call(installation.accessToken, "conversations.invite", {
      channel: channelId,
      users: input.slackUserId,
    });
  } catch (error) {
    if (!(error instanceof SlackApiError && error.code === "already_in_channel")) {
      await deps.update(organizationId, { lastError: errorMessage(error) });
      throw error;
    }
  }
  await deps.update(organizationId, { lastError: null, status: "joined" });
  return "joined";
}

async function createHostChannel(
  config: SlackConnectConfig,
  call: SlackCall,
  companyName: string,
): Promise<{ channelId: string; channelName: string }> {
  for (let attempt = 0; attempt < channelNameAttempts; attempt += 1) {
    const name = slackConnectChannelName(companyName, attempt);
    try {
      const created = await call(config.hostToken, "conversations.create", {
        is_private: "false",
        name,
      });
      const channel = created.channel as { id?: unknown; name?: unknown } | undefined;
      if (typeof channel?.id !== "string") {
        throw new SlackApiError("conversations.create", "missing_channel");
      }
      return {
        channelId: channel.id,
        channelName: typeof channel.name === "string" ? channel.name : name,
      };
    } catch (error) {
      if (error instanceof SlackApiError && error.code === "name_taken") continue;
      throw error;
    }
  }
  throw new SlackApiError("conversations.create", "name_taken");
}

async function addHostMembers(
  config: SlackConnectConfig,
  deps: SlackConnectDeps,
  channelId: string,
): Promise<void> {
  if (config.hostUserIds.length === 0) return;
  await deps
    .call(config.hostToken, "conversations.invite", {
      channel: channelId,
      force: "true",
      users: config.hostUserIds.join(","),
    })
    .catch((error: unknown) => {
      deps.log("slack_connect_host_members_failed", {
        channelId,
        error: errorMessage(error),
      });
    });
}

// Sends a Slack Connect invitation from the operator's Slack. Full access is
// asked for first; a Slack that only allows limited invitations gets one.
async function inviteShared(
  config: SlackConnectConfig,
  call: SlackCall,
  channelId: string,
  target: { emails: string } | { user_ids: string },
): Promise<Record<string, unknown>> {
  try {
    return await call(config.hostToken, "conversations.inviteShared", {
      channel: channelId,
      external_limited: "false",
      ...target,
    });
  } catch (error) {
    if (!(error instanceof SlackApiError && error.code === "restricted_action")) {
      throw error;
    }
    return call(config.hostToken, "conversations.inviteShared", {
      channel: channelId,
      ...target,
    });
  }
}

async function shareWithApp(
  config: SlackConnectConfig,
  deps: SlackConnectDeps,
  installation: SlackConnectInstallation,
  channelId: string,
  channelName: string,
): Promise<void> {
  const invite = await inviteShared(config, deps.call, channelId, {
    user_ids: installation.botUserId,
  });
  if (typeof invite.invite_id !== "string") {
    throw new SlackApiError("conversations.inviteShared", "missing_invite_id");
  }
  for (let attempt = 0; attempt < channelNameAttempts; attempt += 1) {
    const name =
      attempt === 0
        ? channelName
        : `${channelName.slice(0, slackChannelNameLimit - 3)}-${attempt + 1}`;
    try {
      await deps.call(installation.accessToken, "conversations.acceptSharedInvite", {
        channel_name: name,
        invite_id: invite.invite_id,
      });
      return;
    } catch (error) {
      if (error instanceof SlackApiError && error.code === "name_taken") continue;
      throw error;
    }
  }
  throw new SlackApiError("conversations.acceptSharedInvite", "name_taken");
}

async function inviteByEmail(
  config: SlackConnectConfig,
  deps: SlackConnectDeps,
  input: SlackConnectJobInput,
  channelId: string,
): Promise<SlackConnectOutcome> {
  const email = await deps.userEmail(input.userId);
  if (!email) {
    await deps.update(input.organizationId, {
      lastError: "The member who connected Slack has no email address",
      status: "failed",
    });
    return "failed";
  }
  try {
    await inviteShared(config, deps.call, channelId, { emails: email });
  } catch (error) {
    await deps.update(input.organizationId, { lastError: errorMessage(error) });
    if (isTransient(error)) throw error;
    await deps.update(input.organizationId, { status: "failed" });
    return "failed";
  }
  await deps.update(input.organizationId, { lastError: null, status: "invited" });
  return "invited";
}

const installationCredentialsSchema = z.object({ accessToken: z.string().min(1) });
const installationMetadataSchema = z.object({
  botUserId: z.string().min(1),
  scopes: z.array(z.string()).default([]),
});

async function loadInstallation(
  integrationAccountId: string,
): Promise<SlackConnectInstallation | null> {
  const account = await getConnectedIntegrationAccountCredential({
    integrationAccountId,
    provider: "slack",
  });
  if (!account?.encryptedCredentials) return null;
  const metadata = installationMetadataSchema.safeParse(account.metadata);
  if (!metadata.success) return null;
  const credentials = installationCredentialsSchema.parse(
    decryptCredentials<Record<string, unknown>>(account.encryptedCredentials),
  );
  return {
    accessToken: credentials.accessToken,
    botUserId: metadata.data.botUserId,
    scopes: metadata.data.scopes,
  };
}

export function slackConnectDeps(
  env: NodeJS.ProcessEnv = process.env,
): SlackConnectDeps {
  return {
    call: callSlack,
    claim: claimSlackConnectChannel,
    config: slackConnectConfig(env),
    installation: loadInstallation,
    log: (event, fields) => {
      console.warn(JSON.stringify({ event, ...fields }));
    },
    organizationName: getOrganizationName,
    update: updateSlackConnectChannel,
    userEmail: getUserEmail,
  };
}
