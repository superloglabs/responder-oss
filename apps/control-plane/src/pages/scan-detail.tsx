import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { CaretRightIcon } from "@phosphor-icons/react";
import { fetchScan } from "../scans-api";
import { AppShell } from "../components/app-shell";
import { DataTable } from "../design-system";
import { useDocumentTitle } from "../use-document-title";
import "./scan-suggestions.css";
import { findingsForScan, scanRuns, type ScanFinding, type ScanRun } from "./scan-data";
import { failureReasonWithFindings, scanDateLabel } from "./scan-detail-presentation";

function FindingSection({ findings, isStoryboard, label }: {
  findings: ScanFinding[];
  isStoryboard: boolean;
  label: string;
}) {
  if (findings.length === 0) return null;
  return (
    <section aria-label={label} className="scanFindingSection">
      <h2 className="scanFindingSection__heading">{label} <span>{findings.length}</span></h2>
      <div className="scanFindingsTable">
        <DataTable
          aria-label={`${label} in this scan`}
          columns={[
            {
              header: "Finding", key: "finding", width: "59.3%",
              render: (finding) => (
                <span className="scanFindingTitle">
                  <strong>{finding.title}</strong>
                  <small>{finding.evidence}</small>
                </span>
              ),
            },
            { header: "Source", key: "source", width: "13.8%", render: (finding) => finding.source },
            { header: "Severity", key: "severity", width: "11.6%", render: (finding) => finding.severity },
            {
              header: "Issue", key: "issue", width: "15.3%",
              render: (finding) => (
                <Link
                  aria-label={`Open ${finding.issueLabel}`}
                  className="scanFindingIssue"
                  to={isStoryboard ? "/issues" : `/issues/${finding.id}`}
                >
                  <span>{finding.issueLabel}</span>
                  <CaretRightIcon aria-hidden="true" size={12} />
                </Link>
              ),
            },
          ]}
          getRowKey={(finding) => finding.id}
          rows={findings}
        />
      </div>
    </section>
  );
}

export function ScanDetailPage() {
  const { scanId } = useParams();
  const { pathname } = useLocation();
  const isStoryboard = pathname.startsWith("/_storyboards");
  const storyboardRun = isStoryboard
    ? scanRuns.find((candidate) => candidate.id === scanId) ?? null
    : null;
  const [scan, setScan] = useState<ScanRun | null>(storyboardRun);
  const [findings, setFindings] = useState<ScanFinding[]>(
    storyboardRun ? findingsForScan(storyboardRun) : [],
  );
  const [loading, setLoading] = useState(!isStoryboard);
  const [error, setError] = useState<string | null>(null);
  const scansPath = isStoryboard ? "/_storyboards/scans" : "/scans";

  useEffect(() => {
    if (isStoryboard || !scanId) return;
    const requestedScanId = scanId;
    let cancelled = false;
    let timer: number | undefined;
    async function loadScan() {
      let pollAgain = false;
      try {
        const result = await fetchScan(requestedScanId);
        if (cancelled) return;
        setScan(result.run);
        setFindings(result.findings);
        setError(null);
        pollAgain = result.run.status === "running";
      } catch (caught) {
        pollAgain = true;
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : "Unable to load scan");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          if (pollAgain) timer = window.setTimeout(() => void loadScan(), 5_000);
        }
      }
    }
    void loadScan();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [isStoryboard, scanId]);

  useDocumentTitle(scan ? `Scan · ${scan.startedLabel}` : "Scan");
  if (isStoryboard && !scan) return <Navigate replace to={scansPath} />;

  const newFindings = findings.filter((finding) => finding.outcome === "filed");
  const existingFindings = findings.filter((finding) => finding.outcome === "existing");
  const partialFailureReason = scan
    ? failureReasonWithFindings(scan.status, scan.failureReason, findings.length)
    : null;

  return (
    <AppShell active="scans" density="scans" redesigned>
      <div className="scanDetail">
        <nav aria-label="Breadcrumb" className="workspaceBreadcrumb">
          <Link to={scansPath}>Scans</Link>
          <span aria-hidden="true">›</span>
          <span>Scan details</span>
        </nav>
        {loading ? <p>Loading scan…</p> : null}
        {error ? <p className="formError">{error}</p> : null}
        {scan ? (
          <>
            <header className="scanDetailHeading">
              <h1>{scanDateLabel(scan.startedAt)}</h1>
              <span className={`scanRunStatus scanRunStatus--${scan.status}`}>
                <span aria-hidden="true" />
                {scan.status === "completed" ? "Completed" : scan.status === "running" ? "Running" : "Failed"}
              </span>
            </header>
            {partialFailureReason ? (
              <p className="scanDetailFailure" role="alert">Scan failed: {partialFailureReason}</p>
            ) : null}
            {findings.length === 0 ? (
              <section className="emptyState emptyState--list">
                <h2>
                  {scan.status === "running"
                    ? "Scan in progress"
                    : scan.status === "failed"
                      ? "Scan did not complete"
                      : "No active issues found"}
                </h2>
                <p>
                  {scan.status === "running"
                    ? "Findings will appear here as soon as the scan completes."
                    : scan.status === "failed"
                      ? scan.failureReason ?? "Try running the scan again."
                      : "This scan did not identify a problem that needed filing."}
                </p>
              </section>
            ) : (
              <div className="scanDetailFindings">
                <FindingSection findings={newFindings} isStoryboard={isStoryboard} label="New issues" />
                <FindingSection findings={existingFindings} isStoryboard={isStoryboard} label="Existing issues" />
              </div>
            )}
          </>
        ) : null}
      </div>
    </AppShell>
  );
}
