import { readFileSync } from "node:fs";

const environmentKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const responderSecretsJSONPath = "/run/responder/secrets.json";
const responderSecretsLegacyPath = "/run/responder/secrets.env";

type ResponderSecret = {
  key: string;
  value: string;
};

function parseResponderSecrets(contents: string): ResponderSecret[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("Responder secrets JSON file must contain valid JSON");
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Responder secrets JSON file must contain a nonempty array");
  }

  const keys = new Set<string>();
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`Responder secret at index ${index} must be an object`);
    }

    const { key, value } = entry as Record<string, unknown>;
    if (typeof key !== "string" || !environmentKeyPattern.test(key)) {
      throw new Error(
        `Responder secret at index ${index} has an invalid environment key`,
      );
    }
    if (typeof value !== "string") {
      throw new Error(
        `Responder secret at index ${index} must have a string value`,
      );
    }
    if (value.includes("\0")) {
      throw new Error(
        `Responder secret at index ${index} contains an unsupported null byte`,
      );
    }
    if (keys.has(key)) {
      throw new Error(
        `Responder secret at index ${index} duplicates environment key ${key}`,
      );
    }
    keys.add(key);

    return { key, value };
  });
}

export function loadResponderSecrets(
  environment: NodeJS.ProcessEnv = process.env,
  loadLegacyEnvFile: (path: string) => void = (path) =>
    process.loadEnvFile(path),
  readSecretsJSONFile: () => string = () =>
    readFileSync(responderSecretsJSONPath, "utf8"),
): void {
  const jsonPath = environment.RESPONDER_SECRETS_JSON_FILE;
  if (jsonPath !== undefined) {
    if (jsonPath.length === 0) {
      throw new Error("RESPONDER_SECRETS_JSON_FILE must not be empty");
    }
    if (jsonPath !== responderSecretsJSONPath) {
      throw new Error(
        `RESPONDER_SECRETS_JSON_FILE must be ${responderSecretsJSONPath}`,
      );
    }

    let contents: string;
    try {
      contents = readSecretsJSONFile();
    } catch {
      throw new Error("Unable to read responder secrets JSON file");
    }

    const secrets = parseResponderSecrets(contents);
    for (const { key, value } of secrets) {
      if (!Object.hasOwn(environment, key)) environment[key] = value;
    }
    return;
  }

  const legacyPath = environment.RESPONDER_SECRETS_FILE;
  if (legacyPath !== undefined) {
    if (legacyPath.length === 0) {
      throw new Error("RESPONDER_SECRETS_FILE must not be empty");
    }
    if (legacyPath !== responderSecretsLegacyPath) {
      throw new Error(
        `RESPONDER_SECRETS_FILE must be ${responderSecretsLegacyPath}`,
      );
    }
    loadLegacyEnvFile(responderSecretsLegacyPath);
  }
}
