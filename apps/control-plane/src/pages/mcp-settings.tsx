import { useState } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "../components/app-shell";
import { SettingsHeading } from "../components/settings-heading";
import { CodeBlock, Tabs } from "../design-system";
import {
  mcpClientSetups,
  mcpServerUrl,
  type McpClientId,
} from "../mcp-connection-snippets";
import { useDocumentTitle } from "../use-document-title";

const docsUrl = "https://docs.superlog.sh/api-reference/mcp";

export function McpSettingsPage() {
  useDocumentTitle("MCP");
  const serverUrl = mcpServerUrl(window.location.origin);
  const setups = mcpClientSetups(serverUrl);
  const [client, setClient] = useState<McpClientId>("claude-code");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setup = setups.find((option) => option.value === client) ?? setups[0];

  async function copyUrl() {
    setError(null);
    try {
      await navigator.clipboard.writeText(serverUrl);
      setNotice("Server URL copied.");
    } catch {
      setNotice(null);
      setError("Unable to copy. Select the URL and copy it manually.");
    }
  }

  return (
    <AppShell active="settings" density="settings" redesigned>
      <SettingsHeading active="mcp" />

      <section className="workspaceSettings">
        <p className="memberAccessNote">
          Connect Superlog to Claude, Cursor, or another{" "}
          <a href={docsUrl} rel="noreferrer" target="_blank">MCP client</a>.
          The client asks you to sign in and choose a workspace, then acts as
          you there. It can read and change automations, their runs, tag mode,
          and model access.
        </p>

        {error ? <p className="settingsNotice settingsNotice--error">{error}</p> : null}
        {notice ? <p className="settingsNotice settingsNotice--success">{notice}</p> : null}

        <div className="inviteForm">
          <div>
            <h3>Server URL</h3>
            <p>Streamable HTTP. Clients sign in with OAuth.</p>
          </div>
          <div className="invitationLink">
            <input aria-label="MCP server URL" readOnly value={serverUrl} />
            <button className="button button--secondary" onClick={() => void copyUrl()} type="button">
              Copy URL
            </button>
          </div>
        </div>

        <div className="memberSection mcpSetup">
          <div className="memberSection__heading">
            <h3>Connect a client</h3>
          </div>
          <Tabs
            aria-label="MCP client"
            onChange={setClient}
            options={setups.map(({ label, value }) => ({ label, value }))}
            value={client}
          />
          <div aria-label={setup.label} className="mcpSetup__panel" role="tabpanel">
            <p>{setup.instructions}</p>
            <CodeBlock code={setup.snippet} language={setup.language} />
            <p>{setup.signIn}</p>
          </div>
        </div>

        <p className="mcpSetup__apiKeys">
          For a client that cannot sign in, send an{" "}
          <Link to="/settings/api-keys">API key</Link> as{" "}
          <code>Authorization: Bearer &lt;key&gt;</code> instead.
        </p>
      </section>
    </AppShell>
  );
}
