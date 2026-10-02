import { writeFileSync } from "node:fs";
import { buildOpenApiDocument } from "../server/management/openapi.js";
import { managementOperations } from "../server/management/operations.js";

// Writes the management API's OpenAPI document, for the hosted docs.
// Usage: pnpm api:openapi [output-path] [origin]
const [output, origin = "https://superlog.sh"] = process.argv.slice(2);
const document = `${JSON.stringify(buildOpenApiDocument(managementOperations, origin), null, 2)}\n`;
if (output) writeFileSync(output, document);
else process.stdout.write(document);
