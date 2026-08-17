import { describe, expect, it, vi } from "vitest";
import { loadResponderSecrets } from "./secrets.js";

describe("responder secrets", () => {
  const jsonPath = "/run/responder/secrets.json";
  const legacyPath = "/run/responder/secrets.env";

  it("loads string values without changing their representation", () => {
    const entries = [
      { key: "QUOTED", value: `single ' and double " quotes` },
      { key: "BACKSLASH", value: String.raw`C:\secrets\value` },
      { key: "WHITESPACE", value: "tab\tnewline\nend" },
      { key: "UNICODE", value: "Kampala 🌍 東京" },
      { key: "EMPTY", value: "" },
    ];
    const environment: NodeJS.ProcessEnv = {
      RESPONDER_SECRETS_JSON_FILE: jsonPath,
    };

    loadResponderSecrets(environment, vi.fn(), () => JSON.stringify(entries));

    expect(environment).toMatchObject(
      Object.fromEntries(entries.map(({ key, value }) => [key, value])),
    );
  });

  it("preserves environment values that were already present", () => {
    const environment: NodeJS.ProcessEnv = {
      EXISTING_SECRET: "from-environment",
      RESPONDER_SECRETS_JSON_FILE: jsonPath,
    };

    loadResponderSecrets(environment, vi.fn(), () =>
      JSON.stringify([
        { key: "EXISTING_SECRET", value: "from-file" },
        { key: "NEW_SECRET", value: "new-value" },
      ]),
    );

    expect(environment.EXISTING_SECRET).toBe("from-environment");
    expect(environment.NEW_SECRET).toBe("new-value");
  });

  it.each([
    ["invalid JSON", "{"],
    ["an empty document", ""],
    ["an empty array", "[]"],
    ["a non-array value", "{}"],
    ["a non-object entry", '["secret"]'],
    ["a missing key", '[{"value":"secret"}]'],
    ["an invalid key", '[{"key":"BAD-KEY","value":"secret"}]'],
    ["a non-string value", '[{"key":"SECRET","value":1}]'],
    ["a null byte", '[{"key":"SECRET","value":"\\u0000"}]'],
  ])("fails closed for %s", (_description, contents) => {
    const environment: NodeJS.ProcessEnv = {
      RESPONDER_SECRETS_JSON_FILE: jsonPath,
    };

    expect(() =>
      loadResponderSecrets(environment, vi.fn(), () => contents),
    ).toThrow();
    expect(environment.SECRET).toBeUndefined();
  });

  it("identifies the duplicate key and its index", () => {
    const environment: NodeJS.ProcessEnv = {
      RESPONDER_SECRETS_JSON_FILE: jsonPath,
    };

    expect(() =>
      loadResponderSecrets(
        environment,
        vi.fn(),
        () =>
          '[{"key":"SECRET","value":"one"},{"key":"SECRET","value":"two"}]',
      ),
    ).toThrow("Responder secret at index 1 duplicates environment key SECRET");
    expect(environment.SECRET).toBeUndefined();
  });

  it("fails closed when the configured JSON file is missing", () => {
    const environment: NodeJS.ProcessEnv = {
      RESPONDER_SECRETS_JSON_FILE: jsonPath,
    };

    expect(() =>
      loadResponderSecrets(environment, vi.fn(), () => {
        throw new Error("missing");
      }),
    ).toThrow("Unable to read responder secrets JSON file");
  });

  it("does not partially apply a malformed document", () => {
    const environment: NodeJS.ProcessEnv = {
      RESPONDER_SECRETS_JSON_FILE: jsonPath,
    };

    expect(() =>
      loadResponderSecrets(
        environment,
        vi.fn(),
        () =>
          '[{"key":"VALID","value":"secret"},{"key":"INVALID-KEY","value":"secret"}]',
      ),
    ).toThrow();
    expect(environment.VALID).toBeUndefined();
  });

  it("falls back to the legacy env file when JSON is not configured", () => {
    const loadLegacyEnvFile = vi.fn();
    const environment: NodeJS.ProcessEnv = {
      RESPONDER_SECRETS_FILE: legacyPath,
    };

    loadResponderSecrets(environment, loadLegacyEnvFile);

    expect(loadLegacyEnvFile).toHaveBeenCalledExactlyOnceWith(
      legacyPath,
    );
  });

  it("prefers JSON and does not load the legacy file", () => {
    const loadLegacyEnvFile = vi.fn();
    const environment: NodeJS.ProcessEnv = {
      RESPONDER_SECRETS_FILE: legacyPath,
      RESPONDER_SECRETS_JSON_FILE: jsonPath,
    };

    loadResponderSecrets(
      environment,
      loadLegacyEnvFile,
      () => '[{"key":"SECRET","value":"json"}]',
    );

    expect(environment.SECRET).toBe("json");
    expect(loadLegacyEnvFile).not.toHaveBeenCalled();
  });

  it("does not fall back to legacy secrets when the JSON file is invalid", () => {
    const loadLegacyEnvFile = vi.fn();
    const environment: NodeJS.ProcessEnv = {
      RESPONDER_SECRETS_FILE: legacyPath,
      RESPONDER_SECRETS_JSON_FILE: jsonPath,
    };

    expect(() =>
      loadResponderSecrets(environment, loadLegacyEnvFile, () => "[]"),
    ).toThrow("Responder secrets JSON file must contain a nonempty array");
    expect(loadLegacyEnvFile).not.toHaveBeenCalled();
  });

  it.each(["RESPONDER_SECRETS_JSON_FILE", "RESPONDER_SECRETS_FILE"] as const)(
    "rejects an empty %s path",
    (key) => {
      const environment: NodeJS.ProcessEnv = { [key]: "" };
      expect(() => loadResponderSecrets(environment)).toThrow(
        `${key} must not be empty`,
      );
    },
  );

  it.each([
    ["RESPONDER_SECRETS_JSON_FILE", jsonPath],
    ["RESPONDER_SECRETS_FILE", legacyPath],
  ] as const)("rejects a nonstandard %s path", (key, expectedPath) => {
    const environment: NodeJS.ProcessEnv = { [key]: "/tmp/secrets" };
    expect(() => loadResponderSecrets(environment)).toThrow(
      `${key} must be ${expectedPath}`,
    );
  });
});
