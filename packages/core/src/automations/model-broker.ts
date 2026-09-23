import { createHash, randomBytes } from "node:crypto";

const automationModelBrokerTokenPattern =
  /^rmb_v1_[A-Za-z0-9_-]{43}$/u;

export interface IssuedAutomationModelBrokerToken {
  token: string;
  tokenHash: string;
}

export function automationModelBrokerTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function issueAutomationModelBrokerToken(
  randomBytesFactory: (size: number) => Buffer = randomBytes,
): IssuedAutomationModelBrokerToken {
  const token = `rmb_v1_${randomBytesFactory(32).toString("base64url")}`;
  return { token, tokenHash: automationModelBrokerTokenHash(token) };
}

export function readAutomationModelBrokerBearerToken(
  authorization: string | null,
): string | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  return automationModelBrokerTokenPattern.test(token) ? token : null;
}
