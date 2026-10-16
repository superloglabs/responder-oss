import { CheckIcon, CopySimpleIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

// Copies a prompt for a coding agent. A prompt that must be loaded first is
// handed to the clipboard as a pending item, so the copy still counts as part
// of the click once it arrives.
async function copyText(text: string | Promise<string>) {
  if (typeof text !== "string" && typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    await navigator.clipboard.write([
      new ClipboardItem({ "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })) }),
    ]);
    return;
  }
  await navigator.clipboard.writeText(await text);
}

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
