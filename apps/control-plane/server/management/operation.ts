import type { z } from "zod";

// The caller of a management API request or MCP tool call. API keys act as
// the member who created them.
export interface ManagementContext {
  apiKeyId: string;
  organizationId: string;
  role: string;
  source: "api" | "mcp";
  user: { email: string; id: string; name: string };
}

export type ManagementErrorStatus = 400 | 403 | 404 | 409 | 422 | 502 | 503;

export class ManagementError extends Error {
  constructor(
    readonly status: ManagementErrorStatus,
    message: string,
    readonly code?: string,
    readonly issues?: z.core.$ZodIssue[],
  ) {
    super(message);
    this.name = "ManagementError";
  }
}

export type ManagementTag =
  | "API keys"
  | "Automations"
  | "Integrations"
  | "Models"
  | "Runs"
  | "Secrets"
  | "Tag mode"
  | "Workspace";

// Responses are serialized as JSON before they are checked against the
// output schema, so a Date may stand in for a timestamp string.
export type Serializable<T> = T extends string
  ? string | Date
  : T extends Array<infer Item>
    ? Array<Serializable<Item>>
    : T extends object
      ? { [Key in keyof T]: Serializable<T[Key]> }
      : T;

// One management capability. The REST route, the MCP tool, and the OpenAPI
// operation are all generated from this definition. Path parameters come from
// the path; a GET reads its remaining fields from the query string and other
// methods from the JSON body.
export interface ManagementOperation<
  Input extends z.ZodObject = z.ZodObject,
  Output extends z.ZodType = z.ZodType,
> {
  description: string;
  // Hides the operation from MCP clients when it handles values that should
  // not pass through a model, such as provider API keys.
  mcp?: false;
  method: "DELETE" | "GET" | "PATCH" | "POST";
  // The MCP tool name and OpenAPI operation ID.
  name: string;
  output: Output;
  path: string;
  // Read-only operations change nothing. Destructive ones remove access or
  // data that cannot be restored through the API.
  effect: "destructive" | "read" | "write";
  input: Input;
  requiresAutomations?: true;
  run(
    context: ManagementContext,
    input: z.output<Input>,
  ): Promise<Serializable<z.input<Output>>>;
  successStatus?: 200 | 201 | 202;
  summary: string;
  tag: ManagementTag;
}

export function defineOperation<
  Input extends z.ZodObject,
  Output extends z.ZodType,
>(operation: ManagementOperation<Input, Output>): ManagementOperation {
  return operation as unknown as ManagementOperation;
}

export function pathParameterNames(path: string): string[] {
  return [...path.matchAll(/\{([A-Za-z]+)\}/gu)].map((match) => match[1]!);
}
