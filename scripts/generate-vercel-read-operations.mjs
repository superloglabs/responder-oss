import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SOURCE_URL = "https://openapi.vercel.sh/";
const OUTPUT_PATH = resolve(
  "apps/worker/src/generated/vercel-read-operations.json",
);
const SENSITIVE_PATH =
  /(?:^|\/)(?:api-keys?|env|environment-variables?|secrets?|tokens?)(?:\/|$)/iu;
const SENSITIVE_OPERATION =
  /(?:authCode|credential|decrypt|environmentVariable|secret|token)/iu;
const SENSITIVE_TAGS = new Set(["authentication", "environment"]);

function compactText(value, maxLength = 1_200) {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact ? compact.slice(0, maxLength) : undefined;
}

function resolveReference(specification, value) {
  if (!value?.$ref) return value;
  if (!value.$ref.startsWith("#/")) return undefined;
  return value.$ref
    .slice(2)
    .split("/")
    .reduce(
      (current, part) => current?.[part.replaceAll("~1", "/").replaceAll("~0", "~")],
      specification,
    );
}

function compactSchema(specification, input) {
  const schema = resolveReference(specification, input) ?? input ?? {};
  return {
    ...(typeof schema.type === "string" ? { type: schema.type } : {}),
    ...(Array.isArray(schema.enum) ? { enum: schema.enum.slice(0, 100) } : {}),
    ...(schema.default !== undefined ? { default: schema.default } : {}),
    ...(typeof schema.minimum === "number" ? { minimum: schema.minimum } : {}),
    ...(typeof schema.maximum === "number" ? { maximum: schema.maximum } : {}),
    ...(schema.items ? { items: compactSchema(specification, schema.items) } : {}),
  };
}

function compactParameter(specification, input) {
  const parameter = resolveReference(specification, input);
  if (!parameter || !["path", "query"].includes(parameter.in)) return null;
  return {
    name: parameter.name,
    in: parameter.in,
    required: parameter.in === "path" || parameter.required === true,
    ...(compactText(parameter.description, 500)
      ? { description: compactText(parameter.description, 500) }
      : {}),
    schema: compactSchema(specification, parameter.schema),
  };
}

function operationIsSafe(path, operation) {
  const tags = Array.isArray(operation.tags) ? operation.tags : [];
  return !(
    SENSITIVE_PATH.test(path) ||
    SENSITIVE_OPERATION.test(operation.operationId ?? "") ||
    tags.some((tag) => SENSITIVE_TAGS.has(tag))
  );
}

const response = await fetch(SOURCE_URL, {
  headers: { accept: "application/json" },
  redirect: "error",
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) {
  throw new Error(`Unable to download Vercel OpenAPI: HTTP ${response.status}`);
}
const specification = await response.json();
const operations = [];

for (const [path, pathItem] of Object.entries(specification.paths ?? {})) {
  const operation = pathItem?.get;
  if (!operation?.operationId || !operationIsSafe(path, operation)) continue;
  const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
    .map((parameter) => compactParameter(specification, parameter))
    .filter(Boolean);
  operations.push({
    operationId: operation.operationId,
    path,
    summary: compactText(operation.summary) ?? operation.operationId,
    ...(compactText(operation.description)
      ? { description: compactText(operation.description) }
      : {}),
    tags: Array.isArray(operation.tags) ? operation.tags : [],
    parameters,
  });
}

operations.sort((left, right) => left.operationId.localeCompare(right.operationId));
if (operations.length < 50) {
  throw new Error(`Vercel OpenAPI returned only ${operations.length} safe GET operations`);
}

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(
  OUTPUT_PATH,
  `${JSON.stringify({ source: SOURCE_URL, operations }, null, 2)}\n`,
  "utf8",
);
console.log(`Generated ${operations.length} Vercel read operations`);
