import { Hono } from "hono";
import { z } from "zod";
import { captureAnalyticsEvent } from "@responder/core/analytics";
import {
  decryptCredentials,
  encryptCredentials,
} from "../../../../packages/core/src/credentials/encryption.js";
import {
  claimIntegrationRegistration,
  deleteIntegrationAccount,
  getIntegrationAccountByRegistration,
  getIntegrationAccountMergedFromRegistration,
  getOrganizationIntegrationAccount,
  getPendingIntegrationRegistration,
  markIntegrationAccountConnected,
  upsertIntegrationAccount,
} from "../../../../packages/core/src/db/integrations.js";
import {
  awsCloudFormationQuickCreateUrl,
  awsConnectionCredentialsSchema,
  awsIntegrationPrincipalArn,
  awsInvestigationRoleArn,
  awsParameterizedCloudFormationTemplate,
  createAwsCloudFormationTemplateUrl,
  createAwsExternalId,
  verifyAwsInvestigationRole,
} from "../../../../packages/core/src/integrations/aws.js";
import {
  AWS_REGISTRATION_EXPIRED_REASON,
  AWS_REGISTRATION_EXTERNAL_ACCOUNT_PREFIX,
  awsRegistrationCredentialsSchema,
  awsRegistrationExternalAccountId,
  awsRegistrationHash,
  awsRegistrationPhysicalResourceId,
  awsRegistrationTopicArn,
  type CloudFormationCustomResourceRequest,
  cloudFormationCustomResourceRequestSchema,
  type CloudFormationResponse,
  cloudFormationStackAccountId,
  confirmSnsSubscription,
  isAcceptedAwsRegistrationTopic,
  isCloudFormationResponseUrl,
  sendCloudFormationResponse,
  snsMessageSchema,
  verifySnsMessageSignature,
} from "../../../../packages/core/src/integrations/aws-registration.js";
import { getActiveTenant } from "../tenant.js";

export const AWS_REGISTRATION_UNAVAILABLE_ERROR =
  "One-click AWS setup is not available in this region";
const REGISTRATION_DISPLAY_NAME = "AWS · Waiting for CloudFormation";
const ALREADY_USED_REASON =
  "This Superlog setup link was already used for another AWS account. Start again from Superlog.";
const FAILED_REASON =
  "Superlog could not record this AWS account. Start again from Superlog.";
const VERIFY_INTERVAL_MS = 5_000;

function logRegistration(fields: Record<string, unknown>): void {
  const log = fields.outcome === "error" ? console.error : console.info;
  log(JSON.stringify({ event: "aws_registration", ...fields }));
}

function readCredentials<T extends z.ZodType>(
  schema: T,
  encryptedCredentials: string | null | undefined,
): z.infer<T> | null {
  if (!encryptedCredentials) return null;
  try {
    const parsed = schema.safeParse(
      decryptCredentials<Record<string, unknown>>(encryptedCredentials),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type AwsRegistrationStart =
  | { available: false }
  | {
      accountId: string;
      available: true;
      cloudFormationUrl: string | null;
      template: string;
    };

// Prepares a setup link that does not need the customer's account ID. The
// stack reports the account back through the registration topic.
export async function startAwsRegistration(
  organizationId: string,
): Promise<AwsRegistrationStart> {
  const registrationTopicArn = awsRegistrationTopicArn();
  if (!registrationTopicArn) return { available: false };
  const principalArn = awsIntegrationPrincipalArn();

  const pending = await getPendingIntegrationRegistration({
    externalAccountIdPrefix: AWS_REGISTRATION_EXTERNAL_ACCOUNT_PREFIX,
    organizationId,
    provider: "aws",
  });
  const pendingCredentials = readCredentials(
    awsRegistrationCredentialsSchema,
    pending?.encryptedCredentials,
  );
  let accountId: string;
  let externalId: string;
  if (pending && pendingCredentials) {
    accountId = pending.id;
    externalId = pendingCredentials.externalId;
  } else {
    // An unreadable placeholder can never be claimed; replace it so it does
    // not shadow the new one.
    if (pending) {
      await deleteIntegrationAccount({
        integrationAccountId: pending.id,
        organizationId,
        provider: "aws",
      });
    }
    externalId = createAwsExternalId();
    accountId = await upsertIntegrationAccount({
      organizationId,
      provider: "aws",
      externalAccountId: awsRegistrationExternalAccountId(externalId),
      displayName: REGISTRATION_DISPLAY_NAME,
      encryptedCredentials: encryptCredentials({ externalId, registration: true }),
      credentialKeyVersion: 1,
      metadata: {
        permissionPolicy: "AIOpsAssistantPolicy",
        registrationHash: awsRegistrationHash(externalId),
        roleName: "ResponderInvestigationRole",
      },
      status: "pending",
    });
  }

  const templateUrl = await createAwsCloudFormationTemplateUrl();
  return {
    accountId,
    available: true,
    cloudFormationUrl: templateUrl
      ? awsCloudFormationQuickCreateUrl({
          externalId,
          principalArn,
          registrationTopicArn,
          templateUrl,
        })
      : null,
    template: awsParameterizedCloudFormationTemplate({
      externalId,
      principalArn,
      registrationTopicArn,
    }),
  };
}

async function registerAwsAccount(
  request: CloudFormationCustomResourceRequest,
  awsAccountId: string | null,
  physicalResourceId: string,
): Promise<CloudFormationResponse> {
  if (request.RequestType === "Delete") {
    return { PhysicalResourceId: physicalResourceId, Status: "SUCCESS" };
  }
  const failed = (reason: string): CloudFormationResponse => ({
    PhysicalResourceId: physicalResourceId,
    Reason: reason,
    Status: "FAILED",
  });
  if (!awsAccountId) return failed(FAILED_REASON);
  const externalId = z
    .string()
    .min(32)
    .max(256)
    .safeParse(request.ResourceProperties?.ExternalId);
  if (!externalId.success) return failed(AWS_REGISTRATION_EXPIRED_REASON);
  const roleArn = awsInvestigationRoleArn(awsAccountId);
  const reportedRoleArn = request.ResourceProperties?.RoleArn;
  if (reportedRoleArn !== undefined && reportedRoleArn !== roleArn) {
    return failed(FAILED_REASON);
  }

  const registrationHash = awsRegistrationHash(externalId.data);
  const account = await getIntegrationAccountByRegistration({
    externalAccountId: awsRegistrationExternalAccountId(externalId.data),
    provider: "aws",
    registrationHash,
  });
  if (!account) {
    logRegistration({ awsAccountId, outcome: "unknown_external_id" });
    return failed(AWS_REGISTRATION_EXPIRED_REASON);
  }

  const success: CloudFormationResponse = {
    Data: { RoleArn: roleArn },
    PhysicalResourceId: awsRegistrationPhysicalResourceId(awsAccountId),
    Status: "SUCCESS",
  };
  const claimed = !account.externalAccountId.startsWith(
    AWS_REGISTRATION_EXTERNAL_ACCOUNT_PREFIX,
  );
  if (claimed && account.externalAccountId !== awsAccountId) {
    logRegistration({
      awsAccountId,
      organizationId: account.organizationId,
      outcome: "already_claimed",
    });
    return failed(ALREADY_USED_REASON);
  }
  // SNS can deliver a request more than once, and stack updates send it
  // again. A row that already holds these credentials needs no change, and
  // rewriting it would undo a finished connection.
  const stored = readCredentials(
    awsConnectionCredentialsSchema,
    account.encryptedCredentials,
  );
  if (claimed && stored?.externalId === externalId.data) return success;

  const result = await claimIntegrationRegistration({
    displayName: `AWS · ${awsAccountId}`,
    encryptedCredentials: encryptCredentials({
      accountId: awsAccountId,
      externalId: externalId.data,
      roleArn,
    }),
    externalAccountId: awsAccountId,
    organizationId: account.organizationId,
    provider: "aws",
    registrationAccountId: account.id,
    registrationHash,
  });
  if (!result) return failed(AWS_REGISTRATION_EXPIRED_REASON);
  logRegistration({
    awsAccountId,
    integrationAccountId: result.integrationAccountId,
    merged: result.merged,
    organizationId: account.organizationId,
    outcome: "registered",
  });
  return success;
}

// Reports false only when the CloudFormation answer did not upload. SNS
// retries a non-2xx delivery, and that is the one failure a retry can fix.
async function handleCloudFormationRequest(message: string): Promise<boolean> {
  let body: unknown;
  try {
    body = JSON.parse(message);
  } catch {
    body = null;
  }
  const parsed = cloudFormationCustomResourceRequestSchema.safeParse(body);
  if (!parsed.success) {
    logRegistration({ outcome: "invalid_request" });
    return true;
  }
  const request = parsed.data;
  if (!isCloudFormationResponseUrl(request.ResponseURL)) {
    logRegistration({ outcome: "invalid_response_url" });
    return true;
  }
  const awsAccountId = cloudFormationStackAccountId(request.StackId);
  const physicalResourceId =
    request.PhysicalResourceId ??
    awsRegistrationPhysicalResourceId(awsAccountId ?? "unknown");

  let response: CloudFormationResponse;
  try {
    response = await registerAwsAccount(request, awsAccountId, physicalResourceId);
  } catch (error) {
    logRegistration({
      awsAccountId,
      error: error instanceof Error ? error.message : "Unknown error",
      outcome: "error",
      stage: "register",
    });
    response = {
      PhysicalResourceId: physicalResourceId,
      Reason: FAILED_REASON,
      Status: "FAILED",
    };
  }
  try {
    await sendCloudFormationResponse(request, response);
  } catch (error) {
    logRegistration({
      awsAccountId,
      error: error instanceof Error ? error.message : "Unknown error",
      outcome: "error",
      stage: "respond",
    });
    return false;
  }
  return true;
}

const lastVerificationAttempts = new Map<string, number>();

// Each poll may try AssumeRole, but no more than once per interval per
// account, however many tabs or tasks poll it.
function claimVerificationAttempt(accountId: string, now = Date.now()): boolean {
  const last = lastVerificationAttempts.get(accountId);
  if (last !== undefined && now - last < VERIFY_INTERVAL_MS) return false;
  if (lastVerificationAttempts.size > 1_000) {
    for (const [id, attemptedAt] of lastVerificationAttempts) {
      if (now - attemptedAt >= VERIFY_INTERVAL_MS) lastVerificationAttempts.delete(id);
    }
  }
  lastVerificationAttempts.set(accountId, now);
  return true;
}

export function resetAwsVerificationAttempts(): void {
  lastVerificationAttempts.clear();
}

export const awsRegistrationRoutes = new Hono()
  // SNS delivers here without a session. The signature, topic, and later
  // AssumeRole decide what to trust.
  .post("/registrations", async (context) => {
    let body: unknown;
    try {
      body = JSON.parse(await context.req.text());
    } catch {
      return context.json({ error: "Invalid SNS message" }, 400);
    }
    const parsed = snsMessageSchema.safeParse(body);
    if (!parsed.success) {
      return context.json({ error: "Invalid SNS message" }, 400);
    }
    const message = parsed.data;
    if (!isAcceptedAwsRegistrationTopic(message.TopicArn)) {
      logRegistration({ outcome: "unknown_topic" });
      return context.json({ error: "Forbidden" }, 403);
    }
    if (!(await verifySnsMessageSignature(message))) {
      logRegistration({ outcome: "invalid_signature" });
      return context.json({ error: "Forbidden" }, 403);
    }

    if (message.Type === "SubscriptionConfirmation") {
      try {
        await confirmSnsSubscription(message.SubscribeURL ?? "");
      } catch (error) {
        logRegistration({
          error: error instanceof Error ? error.message : "Unknown error",
          outcome: "error",
          stage: "subscribe",
        });
        return context.json({ error: "Unable to confirm the subscription" }, 502);
      }
      logRegistration({ outcome: "subscribed" });
      return context.body(null, 200);
    }
    if (message.Type === "UnsubscribeConfirmation") {
      return context.body(null, 200);
    }
    return (await handleCloudFormationRequest(message.Message))
      ? context.body(null, 200)
      : context.json({ error: "Unable to answer CloudFormation" }, 502);
  })
  .get("/setup/:integrationAccountId", async (context) => {
    const tenant = await getActiveTenant(context.req.raw.headers);
    if (tenant.ok === false) {
      return context.json({ error: tenant.error }, tenant.status);
    }
    const integrationAccountId = z.uuid().safeParse(
      context.req.param("integrationAccountId"),
    );
    if (!integrationAccountId.success) {
      return context.json({ error: "The AWS setup session is invalid" }, 400);
    }
    const lookup = {
      organizationId: tenant.organizationId,
      provider: "aws" as const,
    };
    const account =
      (await getOrganizationIntegrationAccount({
        ...lookup,
        integrationAccountId: integrationAccountId.data,
      })) ??
      (await getIntegrationAccountMergedFromRegistration({
        ...lookup,
        registrationAccountId: integrationAccountId.data,
      }));
    if (!account) {
      return context.json({ error: "Start the AWS connection again" }, 404);
    }
    const credentials = readCredentials(
      awsConnectionCredentialsSchema,
      account.encryptedCredentials,
    );
    if (!credentials || !account.encryptedCredentials) {
      return context.json({ status: "waiting" as const });
    }
    const known = {
      awsAccountId: credentials.accountId,
      roleArn: credentials.roleArn,
    };
    if (account.status === "connected") {
      return context.json({ status: "connected" as const, ...known });
    }
    if (!claimVerificationAttempt(account.id)) {
      return context.json({ status: "verifying" as const, ...known });
    }
    try {
      await verifyAwsInvestigationRole(credentials);
    } catch {
      // IAM takes a few seconds to make a new role assumable. Keep polling.
      return context.json({ status: "verifying" as const, ...known });
    }
    const connected = await markIntegrationAccountConnected({
      ...lookup,
      encryptedCredentials: account.encryptedCredentials,
      integrationAccountId: account.id,
    });
    if (connected) {
      await captureAnalyticsEvent({
        distinctId: tenant.user.id,
        event: "integration connected",
        organizationId: tenant.organizationId,
        properties: {
          integration_account_id: account.id,
          provider: "aws",
          setup: "registration",
        },
      });
      return context.json({ status: "connected" as const, ...known });
    }
    // Another poll connected it first, or the credentials changed while this
    // one verified the old ones.
    const current = await getOrganizationIntegrationAccount({
      ...lookup,
      integrationAccountId: account.id,
    });
    return context.json({
      status:
        current?.status === "connected" &&
        current.encryptedCredentials === account.encryptedCredentials
          ? ("connected" as const)
          : ("verifying" as const),
      ...known,
    });
  });
