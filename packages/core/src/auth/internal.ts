import { timingSafeEqual } from "node:crypto";

export function verifyBearerToken(
  authorization: string | null,
  expectedToken = process.env.INTERNAL_INGEST_TOKEN,
): boolean {
  if (!authorization?.startsWith("Bearer ") || !expectedToken) return false;

  const supplied = Buffer.from(authorization.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  if (supplied.length !== expected.length) return false;

  return timingSafeEqual(supplied, expected);
}
