import { CheckIcon, CopySimpleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { copyText } from "../copy-to-clipboard";

export function CopyPromptButton({
  className,
  label = "Copy prompt",
  prompt,
}: {
  className?: string;
  label?: string;
  prompt: () => string | Promise<string>;
}) {
  const [state, setState] = useState<"copied" | "failed" | "idle">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timeout = window.setTimeout(() => setState("idle"), 1_600);
    return () => window.clearTimeout(timeout);
  }, [state]);
  return (
    <button
      className={className ? `copyPromptButton ${className}` : "copyPromptButton"}
      onClick={() => {
        copyText(prompt()).then(
          () => setState("copied"),
          () => setState("failed"),
        );
      }}
      type="button"
    >
      {state === "copied" ? <CheckIcon aria-hidden="true" size={12} /> : <CopySimpleIcon aria-hidden="true" size={12} />}
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}</span>
    </button>
  );
}
