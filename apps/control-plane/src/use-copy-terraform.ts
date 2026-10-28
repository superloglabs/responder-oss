import { useCallback, useEffect, useState } from "react";
import { copyText } from "./copy-to-clipboard";
import { fetchTerraform, type TerraformSelection } from "./terraform-api";

export type CopyState = "copied" | "failed" | "idle";

// Copies the selection's Terraform configuration. The copy starts in the
// click, so the clipboard accepts it after the configuration loads.
// `beforeCopy` finishes saving changes the export should include.
export function useCopyTerraform(
  selection: TerraformSelection,
  beforeCopy?: () => Promise<void>,
): [CopyState, () => void] {
  const [state, setState] = useState<CopyState>("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timeout = window.setTimeout(() => setState("idle"), 1_600);
    return () => window.clearTimeout(timeout);
  }, [state]);
  const key = JSON.stringify(selection);
  const copy = useCallback(() => {
    const saved = beforeCopy ? beforeCopy() : Promise.resolve();
    copyText(saved.then(() => fetchTerraform(JSON.parse(key) as TerraformSelection))).then(
      () => setState("copied"),
      () => setState("failed"),
    );
  }, [beforeCopy, key]);
  return [state, copy];
}

export function copyTerraformLabel(state: CopyState): string {
  return state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy as Terraform";
}
