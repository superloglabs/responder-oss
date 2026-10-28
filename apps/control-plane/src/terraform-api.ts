import { apiErrorMessage } from "./agents-api";

export type TerraformSelection = {
  alertIds?: string[];
  dashboardIds?: string[];
  syntheticCheckIds?: string[];
};

// Terraform configuration for the selected objects, with import blocks.
export async function fetchTerraform(selection: TerraformSelection): Promise<string> {
  const response = await fetch("/api/terraform/export", {
    body: JSON.stringify(selection),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const body = (await response.json().catch(() => null)) as { hcl?: string } | null;
  if (!response.ok || typeof body?.hcl !== "string") throw new Error(apiErrorMessage(body, response.status));
  return body.hcl;
}
