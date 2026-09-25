import { useEffect, useState } from "react";
import { ArrowSquareOutIcon, CheckIcon, CopyIcon } from "@phosphor-icons/react";
import {
  fetchAutomationShare,
  shareAutomation,
  sharedAutomationTemplatePath,
  unshareAutomation,
  type AutomationShare,
} from "../automations-api";
import { copyToClipboard } from "../copy-to-clipboard";
import { AutomationEditorDialog } from "./automation-editor-dialog";

// Shares a saved automation as a public template. The link shows the
// automation as it was when shared or last updated.
export function AutomationShareDialog({ automationId, onClose }: {
  automationId: string;
  onClose: () => void;
}) {
  const [share, setShare] = useState<AutomationShare | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<"share" | "stop" | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = share ? new URL(sharedAutomationTemplatePath(share.slug), window.location.origin).toString() : null;

  useEffect(() => {
    let cancelled = false;
    void fetchAutomationShare(automationId)
      .then((loaded) => {
        if (!cancelled) setShare(loaded);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load sharing");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [automationId]);

  async function publish() {
    setSaving("share");
    setError(null);
    try {
      setShare(await shareAutomation(automationId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to share automation");
    } finally {
      setSaving(null);
    }
  }

  async function stopSharing() {
    setSaving("stop");
    setError(null);
    try {
      await unshareAutomation(automationId);
      setShare(null);
      setCopied(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to stop sharing");
    } finally {
      setSaving(null);
    }
  }

  async function copyLink() {
    if (!url) return;
    try {
      await copyToClipboard(url);
      setCopied(true);
    } catch {
      setError("Unable to copy the link. Select it and copy it instead.");
    }
  }

  const actions = <div className="automationShare__actions">
    {share ? <button className="automationShare__stop" disabled={saving !== null} onClick={() => void stopSharing()} type="button">{saving === "stop" ? "Stopping…" : "Stop sharing"}</button> : null}
    <span className="automationCreate__spacer" />
    {share
      ? <button className="automationCreate__secondary" disabled={saving !== null} onClick={() => void publish()} title="Share the automation's current settings at the same link" type="button">{saving === "share" ? "Updating…" : "Update shared copy"}</button>
      : <button className="automationCreate__save" disabled={loading || saving !== null} onClick={() => void publish()} type="button">{saving === "share" ? "Creating link…" : "Create link"}</button>}
  </div>;

  return (
    <AutomationEditorDialog actions={actions} onClose={onClose} title="Share as template">
      <p className="automationShare__intro">
        Anyone with the link can see this automation and set up a copy in their own workspace.
      </p>
      {share && url ? <div className="automationShare__link">
        <input aria-label="Template link" onFocus={(event) => event.currentTarget.select()} readOnly value={url} />
        <button className="automationCreate__save" onClick={() => void copyLink()} type="button">{copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}{copied ? "Copied" : "Copy link"}</button>
        <a aria-label="Open template page" className="automationCreate__iconButton" href={url} rel="noreferrer" target="_blank"><ArrowSquareOutIcon size={14} /></a>
      </div> : null}
      <p className="automationShare__privacy">
        The link shows the name, description, instructions, trigger types, connectors, and your workspace name.
        Channels, projects, repositories, connections, secrets, and model settings stay private.
        {share ? " Later changes are not shared until you update the shared copy." : ""}
      </p>
      {error ? <p className="formError" role="alert">{error}</p> : null}
    </AutomationEditorDialog>
  );
}
