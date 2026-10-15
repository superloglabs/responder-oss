import { z } from "zod";
import {
  syntheticAssertionKinds,
  syntheticAssertionOps,
  syntheticAssertionOpsByKind,
  syntheticIntervals,
  syntheticMethods,
  type SyntheticAssertion,
} from "./types.js";

// HTTP header names: RFC 9110 tokens.
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
// Values may not carry line breaks or other control characters.
// eslint-disable-next-line no-control-regex
const headerValue = /^[^\u0000-\u0008\u000a-\u001f\u007f]*$/u;
// Set by the request itself.
const reservedHeaders = new Set(["connection", "content-length", "host", "transfer-encoding", "upgrade"]);

export const syntheticUrlSchema = z
  .string()
  .trim()
  .max(2_048)
  .superRefine((value, context) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      context.addIssue({ code: "custom", message: "Enter a full URL, such as https://example.com/health" });
      return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      context.addIssue({ code: "custom", message: "The URL must use HTTP or HTTPS" });
    } else if (url.username || url.password) {
      context.addIssue({ code: "custom", message: "Send credentials in a header, not the URL" });
    }
  });

// A header from the editor. A secret's value is null to keep the saved one.
export const syntheticHeaderInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name every header")
    .max(200)
    .regex(headerName, "Header names use letters, digits and - only")
    .refine((name) => !reservedHeaders.has(name.toLowerCase()), "That header is set by the request"),
  secret: z.boolean().default(false),
  value: z.string().max(8_192).regex(headerValue, "Header values cannot contain line breaks").nullable(),
});
export type SyntheticHeaderInput = z.infer<typeof syntheticHeaderInputSchema>;

export const syntheticAssertionSchema = z
  .object({
    key: z.string().trim().max(500).optional(),
    kind: z.enum(syntheticAssertionKinds),
    op: z.enum(syntheticAssertionOps),
    severity: z.enum(["critical", "degraded"]).default("critical"),
    value: z.string().trim().max(1_000).default(""),
  })
  .superRefine((assertion, context) => {
    const problem = syntheticAssertionProblem(assertion);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

// What is wrong with an assertion, or null.
export function syntheticAssertionProblem(assertion: SyntheticAssertion): string | null {
  if (!syntheticAssertionOpsByKind[assertion.kind].includes(assertion.op)) return "Choose a comparison the assertion supports";
  if ((assertion.kind === "header" || assertion.kind === "json_path") && !assertion.key?.trim()) {
    return assertion.kind === "header" ? "Name the header to check" : "Enter the JSON path to check";
  }
  if (assertion.op === "exists" || assertion.op === "not_exists") return null;
  const number = Number(assertion.value);
  switch (assertion.kind) {
    case "status_code":
      if (/^[1-5]xx$/iu.test(assertion.value) && (assertion.op === "eq" || assertion.op === "neq")) return null;
      return Number.isInteger(number) && number >= 100 && number <= 599 ? null : "Status codes are 100 to 599, or a class such as 2xx";
    case "response_time":
      return Number.isFinite(number) && number > 0 && number <= 60_000 ? null : "Response times are 1 to 60,000 ms";
    case "certificate_expiry":
      return Number.isInteger(number) && number >= 0 && number <= 3_650 ? null : "Enter a number of days";
    case "json_path":
      if ((assertion.op === "lt" || assertion.op === "gt") && !Number.isFinite(number)) return "Compare the value with a number";
      return null;
    case "body":
      return assertion.value ? null : "Enter the text to look for";
    case "header":
      return null;
  }
}

const syntheticSlackSchema = z.object({
  channelId: z.string().trim().min(1).max(64),
  integrationAccountId: z.uuid(),
});

export const syntheticCheckInputSchema = z
  .object({
    assertions: z.array(syntheticAssertionSchema).max(20).default([]),
    // Sent with the request as the body; not for GET or HEAD.
    body: z.string().max(65_536).nullable().default(null),
    enabled: z.boolean().default(true),
    // Consecutive failed runs before the check alerts.
    failuresToAlert: z.number().int().min(1).max(10).default(1),
    followRedirects: z.boolean().default(true),
    headers: z.array(syntheticHeaderInputSchema).max(30).default([]),
    intervalSeconds: z
      .number()
      .int()
      .refine((value) => (syntheticIntervals as readonly number[]).includes(value), "Choose how often to run the check")
      .default(300),
    method: z.enum(syntheticMethods).default("GET"),
    name: z.string().trim().min(1, "Name the check").max(200),
    // Immediate retries before a run counts as failed.
    retries: z.number().int().min(0).max(2).default(1),
    slack: syntheticSlackSchema.nullable().default(null),
    timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
    url: syntheticUrlSchema,
  })
  .superRefine((input, context) => {
    if (input.body && (input.method === "GET" || input.method === "HEAD")) {
      context.addIssue({ code: "custom", message: `${input.method} requests cannot have a body`, path: ["body"] });
    }
  });
export type SyntheticCheckInput = z.infer<typeof syntheticCheckInputSchema>;

// A request to try from the editor. Secrets left blank are filled from the
// saved check when its ID is given.
export const syntheticTestSchema = z.object({
  assertions: z.array(syntheticAssertionSchema).max(20).default([]),
  body: z.string().max(65_536).nullable().default(null),
  checkId: z.uuid().nullable().default(null),
  followRedirects: z.boolean().default(true),
  headers: z.array(syntheticHeaderInputSchema).max(30).default([]),
  method: z.enum(syntheticMethods).default("GET"),
  timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
  url: syntheticUrlSchema,
});
export type SyntheticTestInput = z.infer<typeof syntheticTestSchema>;
