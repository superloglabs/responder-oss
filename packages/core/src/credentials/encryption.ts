import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

interface CredentialEnvelope {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

function credentialKey(encodedKey = process.env.CREDENTIAL_ENCRYPTION_KEY): Buffer {
  if (!encodedKey) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY is required");
  }

  const key = Buffer.from(encodedKey, "base64");
  if (key.length !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

export function encryptCredentials(
  credentials: Record<string, unknown>,
  encodedKey?: string,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, credentialKey(encodedKey), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);

  const envelope: CredentialEnvelope = {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };

  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

export function decryptCredentials<T extends Record<string, unknown>>(
  encodedEnvelope: string,
  encodedKey?: string,
): T {
  const envelope = JSON.parse(
    Buffer.from(encodedEnvelope, "base64").toString("utf8"),
  ) as CredentialEnvelope;

  if (envelope.version !== 1) {
    throw new Error("Unsupported credential envelope version");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    credentialKey(encodedKey),
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");

  return JSON.parse(plaintext) as T;
}
