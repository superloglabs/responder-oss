import { buildOpenApiDocument } from "../server/management/openapi.js";
import { managementOperations } from "../server/management/operations.js";

// Prints the management API's OpenAPI document, for the hosted docs.
// Usage: pnpm -s api:openapi [origin] > openapi.json
const origin = process.argv[2] ?? "https://superlog.sh";
process.stdout.write(
  `${JSON.stringify(buildOpenApiDocument(managementOperations, origin), null, 2)}\n`,
);
