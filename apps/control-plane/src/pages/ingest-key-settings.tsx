import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "../components/app-shell";
import { MemberListSkeleton } from "../components/screen-skeletons";
import { SettingsHeading } from "../components/settings-heading";
import {
  fetchIngestKeys,
  ingestKeyUsage,
  revokeIngestKey,
  type TelemetryIngestKeySummary,
} from "../ingest-keys-api";
import { useDocumentTitle } from "../use-document-title";

const createKeyPath = "/telemetry/setup/opentelemetry";

export function IngestKeySettingsPage() {
  useDocumentTitle("Ingest keys");
  // Undefined while loading; null when this workspace cannot send telemetry to this cell.
  const [keys, setKeys] = useState<TelemetryIngestKeySummary[] | null | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Only the newest list may be shown; older responses are dropped.
  const loadGeneration = useRef(0);

  async function reload() {
    const generation = ++loadGeneration.current;
    const loaded = await fetchIngestKeys();
    if (generation === loadGeneration.current) setKeys(loaded);
  }

  useEffect(() => {
    reload().catch((cause: unknown) => {
      setKeys([]);
      setError(cause instanceof Error ? cause.message : "Unable to load ingest keys");
    });
  }, []);

  async function remove(key: TelemetryIngestKeySummary) {
    if (!window.confirm(`Revoke ${key.name}? Apps that send telemetry with it stop sending.`)) return;
    setBusyId(key.id);
    setError(null);
    setNotice(null);
    try {
      await revokeIngestKey(key.id);
      setNotice(`${key.name} revoked.`);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to revoke the key");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <AppShell active="settings" density="settings" redesigned>
      <SettingsHeading active="ingest-keys" />

      <section className="workspaceSettings">
        <p className="memberAccessNote">
          Ingest keys let your apps send logs, traces and metrics to this workspace with the OpenTelemetry
          SDK. <Link to={createKeyPath}>Create a key</Link> in Add telemetry, where the setup prompt for your
          coding agent includes it.
        </p>

        {error ? <p className="settingsNotice settingsNotice--error">{error}</p> : null}
        {notice ? <p className="settingsNotice settingsNotice--success">{notice}</p> : null}

        <div className="memberSection">
          <div className="memberSection__heading">
            <h3>Ingest keys</h3>
            <span>{keys?.length ?? 0}</span>
          </div>
          {keys === undefined ? <MemberListSkeleton /> : keys === null ? (
            <p className="settingsEmpty">This workspace cannot receive telemetry in this region yet.</p>
          ) : keys.length === 0 ? (
            <p className="settingsEmpty">No ingest keys yet.</p>
          ) : (
            <div className="memberList">
              {keys.map((key) => (
                <div className="memberRow" key={key.id}>
                  <div className="memberIdentity">
                    <strong>{key.name}</strong>
                    <span><code>{key.prefix}…</code> · {ingestKeyUsage(key)}</span>
                  </div>
                  <div className="invitationActions">
                    <button
                      className="memberAction memberAction--danger"
                      disabled={busyId === key.id}
                      onClick={() => void remove(key)}
                      type="button"
                    >
                      Revoke
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </AppShell>
  );
}
