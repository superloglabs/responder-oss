import { getTableConfig } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptCredentials } from "../credentials/encryption.js";
import { getDatabase } from "./client.js";
import {
  claimAutomationModelBrokerGrant,
  createAutomationModelBrokerGrant,
  revokeAutomationModelBrokerGrant,
} from "./automation-model-broker.js";
import { automationModelBrokerGrants } from "./schema.js";

vi.mock("./client.js", () => ({ getDatabase: vi.fn() }));

const encryptionKey = Buffer.alloc(32, 4).toString("base64");
const organizationId = "15151515-1515-4515-8515-151515151515";
const grantId = "21212121-2121-4121-8121-212121212121";

describe("automation model broker grant storage", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("stores only a token hash and an encrypted provider credential", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", encryptionKey);
    const returning = vi.fn().mockResolvedValue([{ id: grantId }]);
    const values = vi.fn().mockReturnValue({ returning });
    vi.mocked(getDatabase).mockReturnValue({
      insert: vi.fn(() => ({ values })),
    } as never);

    const grant = await createAutomationModelBrokerGrant(
      {
        apiKey: "provider-secret",
        expiresAt: new Date("2026-09-22T16:10:00.000Z"),
        maxOutputTokensPerRequest: 4_096,
        maxRequests: 8,
        model: "gpt-5.1-codex",
        leaseId: "31313131-3131-4131-8131-313131313131",
        organizationId,
        provider: "openai",
        runId: "run-1",
      },
      {
        now: () => new Date("2026-09-22T16:00:00.000Z"),
        randomBytes: () => Buffer.alloc(32, 9),
      },
    );

    expect(grant).toMatchObject({
      id: grantId,
      expiresAt: new Date("2026-09-22T16:10:00.000Z"),
    });
    const stored = values.mock.calls[0]![0] as {
      encryptedCredentials: string;
      tokenHash: string;
    } & Record<string, unknown>;
    expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(stored.tokenHash).not.toBe(grant.token);
    expect(stored.encryptedCredentials).not.toContain("provider-secret");
    expect(
      decryptCredentials<{ apiKey: string }>(stored.encryptedCredentials),
    ).toEqual({ apiKey: "provider-secret" });
    expect(stored).toMatchObject({
      credentialKeyVersion: 1,
      maxOutputTokensPerRequest: 4_096,
      organizationId,
      provider: "openai",
      remainingOutputTokens: 32_768,
      remainingRequests: 8,
      runId: "run-1",
    });
  });

  it("atomically claims a matching unexpired allowance", async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY", encryptionKey);
    const encryptedCredentials = Buffer.from("placeholder").toString("base64");
    const returning = vi.fn().mockResolvedValue([
      {
        encryptedCredentials,
        id: grantId,
        maxOutputTokensPerRequest: 4_096,
        model: "gpt-5.1-codex",
        organizationId,
        runId: "run-1",
      },
    ]);
    const where = vi.fn(() => ({ returning }));
    const from = vi.fn(() => ({ where }));
    const set = vi.fn(() => ({ from }));
    vi.mocked(getDatabase).mockReturnValue({
      update: vi.fn(() => ({ set })),
    } as never);
    const decrypt = vi.fn(() => ({ apiKey: "provider-secret" }));

    await expect(
      claimAutomationModelBrokerGrant(
        {
          model: "gpt-5.1-codex",
          provider: "openai",
          requestedMaxOutputTokens: null,
          tokenHash: "a".repeat(64),
        },
        { decryptCredentials: decrypt },
      ),
    ).resolves.toEqual({
      apiKey: "provider-secret",
      grantId,
      maxOutputTokens: 4_096,
      model: "gpt-5.1-codex",
      organizationId,
      runId: "run-1",
    });
    expect(set).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledOnce();
    expect(where).toHaveBeenCalledOnce();
    expect(decrypt).toHaveBeenCalledWith(encryptedCredentials);
  });

  it("returns null instead of falling back when no grant can be claimed", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    vi.mocked(getDatabase).mockReturnValue({
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          from: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })),
        })),
      })),
    } as never);

    await expect(
      claimAutomationModelBrokerGrant({
        model: "gpt-5.1-codex",
        provider: "openai",
        requestedMaxOutputTokens: 2_000,
        tokenHash: "b".repeat(64),
      }),
    ).resolves.toBeNull();
  });

  it("revokes only the grant owned by the expected run and organization", async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const deleteGrant = vi.fn(() => ({ where }));
    vi.mocked(getDatabase).mockReturnValue({
      delete: deleteGrant,
    } as never);

    await revokeAutomationModelBrokerGrant({
      grantId,
      organizationId,
      runId: "run-1",
    });

    expect(deleteGrant).toHaveBeenCalledWith(automationModelBrokerGrants);
    expect(where).toHaveBeenCalledOnce();
  });

  it("defines durable expiry, request, and output-token bounds", () => {
    const config = getTableConfig(automationModelBrokerGrants);
    expect(config.indexes.map((index) => index.config.name)).toEqual(
      expect.arrayContaining([
        "automation_model_broker_grants_expires_idx",
        "automation_model_broker_grants_organization_run_idx",
      ]),
    );
    expect(config.uniqueConstraints).toHaveLength(0);
    expect(
      config.indexes.find(
        (index) =>
          index.config.name === "automation_model_broker_grants_token_hash_idx",
      )?.config.unique,
    ).toBe(true);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "automation_model_broker_grants_request_budget_check",
        "automation_model_broker_grants_output_budget_check",
      ]),
    );
  });
});
