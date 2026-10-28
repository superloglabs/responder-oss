import { CheckIcon, FileCodeIcon } from "@phosphor-icons/react";
import { Button } from "../design-system";
import type { TerraformSelection } from "../terraform-api";
import { copyTerraformLabel, useCopyTerraform } from "../use-copy-terraform";

export function CopyTerraformButton({ selection }: { selection: TerraformSelection }) {
  const [state, copy] = useCopyTerraform(selection);
  return (
    <Button onClick={copy} size="small" variant="ghost">
      {state === "copied" ? <CheckIcon size={12} /> : <FileCodeIcon size={12} />}
      <span aria-live="polite">{copyTerraformLabel(state)}</span>
    </Button>
  );
}
