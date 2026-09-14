import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { fetchScan } from "../scans-api";
import { AppShell } from "../components/app-shell";
import { ArrowIcon } from "../components/icons";
import { DataTable } from "../design-system";
import { useDocumentTitle } from "../use-document-title";
import {
  findingsForScan,
  scanRuns,
  type ScanFinding,
  type ScanRun,
} from "./scan-data";

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
          if (pollAgain) {
            timer = window.setTimeout(() => void loadScan(), 5_000);
          }
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

  const existingIssues = scan ? scan.activeIssues - scan.filedIssues : 0;

  return (
    <AppShell active="scans" density="scans">
      <div className="scanDetail">
        <Link className="scanDetailBack" to={scansPath}>
          <ArrowIcon />
          Scans
        </Link>

        {loading ? <p>Loading scan…</p> : null}
        {error ? <p className="formError">{error}</p> : null}
        {scan ? (
          <>
            <section className="pageHeading scanDetailHeading">
              <div>
                <h1>{scan.startedLabel}</h1>
                <p>
                  {scan.status === "failed"
                    ? `Scan failed${scan.failureReason ? `: ${scan.failureReason}` : "."}`
                    : scan.status === "running"
                      ? `Checking ${scan.sources} integrations now.`
                      : `Completed in ${scan.duration} across ${scan.sources} integrations.`}
                </p>
              </div>
            </section>

            <dl className="scanDetailStats">
              <div>
                <dt>Active findings</dt>
                <dd>{scan.activeIssues}</dd>
              </div>
              <div>
                <dt>New issues filed</dt>
                <dd>{scan.filedIssues}</dd>
              </div>
              <div>
                <dt>Already filed</dt>
                <dd>{existingIssues}</dd>
              </div>
              <div>
                <dt>Posted to Slack</dt>
                <dd>{scan.slackChannelName ? `#${scan.slackChannelName.replace(/^#/, "")}` : "—"}</dd>
              </div>
            </dl>

            <section aria-labelledby="scan-findings-title" className="scanFindings">
              <div className="scanSectionHeading">
                <h2 id="scan-findings-title">Findings</h2>
                <p>Active issues found across the integrations in this scan.</p>
              </div>
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
                <div className="scanFindingsTable">
                  <DataTable
                    aria-label="Scan findings"
                    columns={[
                      {
                        header: "Finding",
                        key: "finding",
                        render: (finding) => (
                          <span className="scanFindingTitle">
                            <strong>{finding.title}</strong>
                            <small>{finding.evidence}</small>
                          </span>
                        ),
                        width: "52%",
                      },
                      {
                        header: "Source",
                        key: "source",
                        render: (finding) => finding.source,
                        width: "13%",
                      },
                      {
                        header: "Severity",
                        key: "severity",
                        render: (finding) => (
                          <span
                            className={`issueTableSeverity issueTableSeverity--${finding.severity.toLowerCase()}`}
                          >
                            {finding.severity}
                          </span>
                        ),
                        width: "12%",
                      },
                      {
                        header: "Result",
                        key: "result",
                        render: (finding) => (
                          <span className="scanFindingResult">
                            <strong>
                              {finding.outcome === "filed" ? "Filed" : "Already filed"}
                            </strong>
                            <small>{finding.issueLabel}</small>
                          </span>
                        ),
                        width: "18%",
                      },
                      {
                        align: "right",
                        header: "",
                        key: "open",
                        render: (finding) => (
                          <Link
                            aria-label={`Open ${finding.issueLabel}`}
                            className="issueTableArrow"
                            to={isStoryboard ? "/issues" : `/issues/${finding.id}`}
                          >
                            <ArrowIcon />
                          </Link>
                        ),
                        width: "5%",
                      },
                    ]}
                    getRowKey={(finding) => finding.id}
                    rows={findings}
                  />
                </div>
              )}
            </section>
          </>
        ) : null}
      </div>
    </AppShell>
  );
}
