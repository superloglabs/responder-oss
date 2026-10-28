import { z } from "zod";
import { buildTerraformExport } from "../terraform/export.js";
import { defineOperation, ManagementError } from "./operation.js";

// Terraform configuration for the superloglabs/superlog provider.

const idList = (what: string) =>
  z
    .string()
    .max(20_000)
    .optional()
    .describe(`Comma-separated ${what} IDs to export.`)
    .transform((value, context) => {
      const ids = (value ?? "").split(",").map((id) => id.trim()).filter(Boolean);
      for (const id of ids) {
        if (!z.uuid().safeParse(id).success) {
          context.addIssue({ code: "custom", message: `${id} is not an ID` });
          return z.NEVER;
        }
      }
      return ids;
    });

export const terraformOperations = [
  defineOperation({
    name: "export_terraform",
    summary: "Export to Terraform",
    description:
      "Returns Terraform configuration for the superloglabs/superlog provider that describes the workspace's alerts, dashboards, and synthetic checks, with an import block for each one, so applying it adopts the existing objects instead of creating copies. Without IDs it exports everything; with IDs it exports only those. Secret header values become sensitive variables to fill in.",
    method: "GET",
    path: "/terraform",
    tag: "Terraform",
    effect: "read",
    input: z.object({
      alertIds: idList("alert"),
      dashboardIds: idList("dashboard"),
      syntheticCheckIds: idList("synthetic check"),
    }),
    output: z.object({
      hcl: z.string().describe("The configuration, for a file such as `superlog.tf`."),
      resources: z.number().int().describe("How many alerts, dashboards, and checks it describes."),
    }),
    async run(context, input) {
      const result = await buildTerraformExport(context.organizationId, input);
      if (!result.ok) throw new ManagementError(404, result.error, "not_found");
      return { hcl: result.hcl, resources: result.resources };
    },
  }),
];
