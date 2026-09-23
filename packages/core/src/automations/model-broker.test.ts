import { describe, expect, it } from "vitest";
import {
  automationModelBrokerTokenHash,
  issueAutomationModelBrokerToken,
  readAutomationModelBrokerBearerToken,
} from "./model-broker.js";

describe("automation model broker tokens", () => {
  it("issues an opaque token and stores only its stable hash", () => {
    const issued = issueAutomationModelBrokerToken(() => Buffer.alloc(32, 7));

    expect(issued.token).toBe(
      "rmb_v1_BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
    );
    expect(issued.tokenHash).toBe(
      automationModelBrokerTokenHash(issued.token),
    );
    expect(issued.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(issued.tokenHash).not.toContain(issued.token);
  });

  it("accepts only the bounded broker bearer-token format", () => {
    const { token } = issueAutomationModelBrokerToken(() => Buffer.alloc(32, 1));

    expect(readAutomationModelBrokerBearerToken(`Bearer ${token}`)).toBe(token);
    expect(readAutomationModelBrokerBearerToken(token)).toBeNull();
    expect(readAutomationModelBrokerBearerToken(`Basic ${token}`)).toBeNull();
    expect(readAutomationModelBrokerBearerToken("Bearer rmb_v1_short")).toBeNull();
    expect(
      readAutomationModelBrokerBearerToken(`Bearer ${token} trailing`),
    ).toBeNull();
  });
});
