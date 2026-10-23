import type { ReactNode } from "react";
import { DataTable, Panel, Skeleton } from "../design-system";
import "./screen-skeletons.css";

export function LoadingRegion({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className: string;
  label: string;
}) {
  return (
    <div aria-busy="true" className={className} role="status">
      <span className="srOnly">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  );
}

function TableSkeleton({
  kind,
  rows = 5,
}: {
  kind: "agents" | "automationRuns" | "investigations";
  rows?: number;
}) {
  const cellCounts = {
    agents: 6,
    automationRuns: 5,
    investigations: 4,
  } as const;

  return (
    <div className={`screenSkeletonTable screenSkeletonTable--${kind}`}>
      {kind === "agents" ? (
        <div className="screenSkeletonTable__filters">
          <Skeleton className="screenSkeletonTable__filter" />
          <Skeleton className="screenSkeletonTable__filter" />
          <Skeleton className="screenSkeletonTable__filter" />
        </div>
      ) : null}
      <div className="screenSkeletonTable__surface">
        <div className="screenSkeletonTable__row screenSkeletonTable__row--header">
          {Array.from({ length: cellCounts[kind] }, (_, index) => (
            <Skeleton key={index} style={{ width: index === 0 ? "40%" : "56%" }} />
          ))}
        </div>
        {Array.from({ length: rows }, (_, rowIndex) => (
          <div className="screenSkeletonTable__row" key={rowIndex}>
            {Array.from({ length: cellCounts[kind] }, (_, cellIndex) => (
              <div className="screenSkeletonTable__cell" key={cellIndex}>
                <Skeleton
                  style={{
                    width:
                      cellIndex === 0
                        ? rowIndex % 2 === 0
                          ? "72%"
                          : "58%"
                        : `${48 + ((rowIndex + cellIndex) % 3) * 14}%`,
                  }}
                />
                {cellIndex === 0 ? (
                  <Skeleton className="screenSkeletonTable__secondary" style={{ width: "88%" }} />
                ) : null}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function AgentListSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton screenSkeleton--list" label="Loading agents…">
      <TableSkeleton kind="agents" />
    </LoadingRegion>
  );
}

export function AutomationListSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton screenSkeleton--list" label="Loading automations…">
      <TableSkeleton kind="agents" />
    </LoadingRegion>
  );
}

export function AutomationRunHistorySkeleton() {
  return (
    <LoadingRegion className="screenSkeleton" label="Loading runs…">
      <TableSkeleton kind="automationRuns" />
    </LoadingRegion>
  );
}

export function PullRequestListSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton screenSkeleton--list" label="Loading pull requests…">
      <TableSkeleton kind="automationRuns" />
    </LoadingRegion>
  );
}

// Mirrors a pull request: breadcrumb, title, then the description card.
export function PullRequestDetailSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton" label="Loading pull request…">
      <div className="automationCreate pullRequestDetail">
        <header className="automationCreate__header">
          <div className="automationCreate__breadcrumb">
            {["40px", "120px"].map((width) => (
              <Skeleton className="automationSkeleton__small" key={width} style={{ width }} />
            ))}
          </div>
          <div className="automationCreate__titleRow">
            <Skeleton className="automationSkeleton__title" style={{ width: "320px" }} />
          </div>
        </header>
        <div className="automationRun__card pullRequestDetail__card">
          {["88%", "94%", "62%"].map((width) => <Skeleton key={width} style={{ width }} />)}
        </div>
      </div>
    </LoadingRegion>
  );
}

// Mirrors the automation editor: breadcrumb, title row, tabs, then the
// trigger, instructions, repository and connector sections.
export function AutomationEditorSkeleton({ saved = true }: { saved?: boolean }) {
  return (
    <LoadingRegion className="screenSkeleton" label="Loading automation…">
      <div className="automationCreate">
        <header className="automationCreate__header">
          <div className="automationCreate__breadcrumb">
            <Skeleton className="automationSkeleton__small" style={{ width: "72px" }} />
            <Skeleton className="automationSkeleton__small" style={{ width: "120px" }} />
          </div>
          <div className="automationCreate__titleRow">
            <Skeleton className="automationSkeleton__title" style={{ width: "220px" }} />
            <span className="automationCreate__spacer" />
            {saved ? <Skeleton className="automationSkeleton__small" style={{ width: "76px" }} /> : null}
            <Skeleton className="automationSkeleton__button" />
          </div>
          {saved ? (
            <div className="automationCreate__tabs automationSkeleton__tabs">
              <Skeleton style={{ width: "52px" }} />
              <Skeleton style={{ width: "76px" }} />
            </div>
          ) : null}
        </header>
        <div className="automationCreate__form">
          <section className="automationCreate__section automationCreate__section--trigger">
            <Skeleton className="automationSkeleton__small" style={{ width: "56px" }} />
            <AutomationRowsSkeleton widths={["34%"]} />
          </section>
          <section className="automationCreate__section">
            <Skeleton className="automationSkeleton__small" style={{ width: "112px" }} />
            <div className="automationCreate__instructions">
              <div className="automationSkeleton__prompt">
                {["92%", "84%", "46%"].map((width) => <Skeleton key={width} style={{ width }} />)}
              </div>
              <div className="automationCreate__toolbar">
                <Skeleton style={{ width: "132px" }} />
              </div>
            </div>
          </section>
          <section className="automationCreate__section">
            <Skeleton className="automationSkeleton__small" style={{ width: "84px" }} />
            <AutomationRowsSkeleton widths={["28%"]} />
          </section>
          <section className="automationCreate__section">
            <Skeleton className="automationSkeleton__small" style={{ width: "76px" }} />
            <AutomationRowsSkeleton widths={["22%", "30%"]} />
          </section>
        </div>
      </div>
    </LoadingRegion>
  );
}

function AutomationRowsSkeleton({ widths }: { widths: string[] }) {
  return (
    <div className="automationCreate__rows automationSkeleton__rows">
      {widths.map((width) => (
        <div className="automationCreate__row" key={width}>
          <Skeleton className="automationSkeleton__icon" variant="circle" />
          <Skeleton style={{ width }} />
        </div>
      ))}
    </div>
  );
}

// Mirrors a run or test chat: breadcrumb, title, transcript and composer.
export function AutomationRunSkeleton({ label, transcript = true }: { label: string; transcript?: boolean }) {
  return (
    <LoadingRegion className="screenSkeleton" label={label}>
      <div className="automationCreate automationRun">
        <header className="automationCreate__header">
          <div className="automationCreate__breadcrumb">
            {["72px", "120px", "56px"].map((width) => (
              <Skeleton className="automationSkeleton__small" key={width} style={{ width }} />
            ))}
          </div>
          <div className="automationCreate__titleRow">
            <Skeleton className="automationSkeleton__title" style={{ width: "260px" }} />
          </div>
        </header>
        <div className="automationRun__transcript">
          {transcript ? (
            <>
              <div className="automationRun__card automationRun__trigger">
                <Skeleton className="automationSkeleton__small" style={{ width: "140px" }} />
                <Skeleton style={{ width: "72%" }} />
              </div>
              <div className="automationSkeleton__message">
                {["88%", "94%", "62%"].map((width) => <Skeleton key={width} style={{ width }} />)}
              </div>
            </>
          ) : (
            <div className="automationSkeleton__message">
              <Skeleton style={{ width: "min(550px, 80%)" }} />
              <Skeleton style={{ width: "min(360px, 60%)" }} />
            </div>
          )}
        </div>
        <div className="automationRun__card automationRun__composer">
          <Skeleton style={{ width: "40%" }} />
          <div className="automationRun__composerActions">
            <Skeleton className="automationSkeleton__button" />
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}

// One date group of the issues table.
export function IssueListSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton" label="Loading issues…">
      <section className="issuesGroup">
        <Skeleton className="automationSkeleton__small pageSkeleton__groupLabel" style={{ width: "48px" }} />
        <div className="issuesTableSurface">
          <table className="issuesTable">
            <colgroup><col className="issuesTable__titleColumn" /><col /><col /></colgroup>
            <thead><tr><th>Issue</th><th>Severity</th><th>Created</th></tr></thead>
            <tbody>
              {Array.from({ length: 6 }, (_, index) => (
                <tr key={index}>
                  <td><span className="tableSkeleton__lines pageSkeleton__issueTitle"><Skeleton style={{ width: lineWidth(index) }} /></span></td>
                  <td><Skeleton className="tableSkeleton__badge" /></td>
                  <td><span className="tableSkeleton__lines"><Skeleton style={{ width: "56px" }} /></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </LoadingRegion>
  );
}

export function AgentDetailSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton screenSkeleton--agent" label="Loading agent…">
      <section className="agentDetailHeading screenSkeleton__detailHeading">
        <div className="screenSkeleton__headingCopy">
          <Skeleton className="screenSkeleton__title" style={{ width: "260px" }} />
          <Skeleton style={{ width: "430px" }} />
        </div>
        <div className="screenSkeleton__actions">
          <Skeleton className="screenSkeleton__toggle" />
          <Skeleton className="screenSkeleton__button" />
        </div>
      </section>

      <Panel className="agentConfiguration screenSkeleton__configuration" padding="default">
        <Skeleton style={{ width: "154px" }} />
        <div className="screenSkeleton__pipeline">
          {Array.from({ length: 3 }, (_, index) => (
            <Panel className="screenSkeleton__pipelineNode" key={index} padding="compact" surface="raised">
              <Skeleton className="screenSkeleton__eyebrow" style={{ width: "28%" }} />
              <Skeleton style={{ width: index === 1 ? "74%" : "60%" }} />
              <Skeleton style={{ width: "88%" }} />
            </Panel>
          ))}
        </div>
      </Panel>

      <section className="agentInvestigations screenSkeleton__investigations">
        <header>
          <Skeleton className="screenSkeleton__sectionTitle" style={{ width: "190px" }} />
          <Skeleton style={{ width: "96px" }} />
        </header>
        <TableSkeleton kind="investigations" rows={4} />
      </section>
    </LoadingRegion>
  );
}

export function IssueDetailSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton screenSkeleton--issue" label="Loading issue…">
      <div className="issueDetail">
        <div className="issueDetail__main screenSkeleton__detailHeading">
          <div className="issueHeader">
            <Skeleton className="screenSkeleton__back" style={{ width: "72px" }} />
            <Skeleton className="screenSkeleton__badge" style={{ width: "260px" }} />
            <Skeleton className="screenSkeleton__title" style={{ width: "min(560px, 72vw)" }} />
          </div>

          <div className="issueProse">
            {["94%", "88%", "62%"].map((width) => (
              <Skeleton key={width} style={{ width }} />
            ))}
          </div>

          <div className="issueCallout">
            <Skeleton className="screenSkeleton__cardTitle" style={{ width: "104px" }} />
            <Skeleton style={{ width: "90%" }} />
            <Skeleton style={{ width: "54%" }} />
          </div>

          {["82px", "112px"].map((titleWidth, section) => (
            <div className="issueSection screenSkeleton__linkedItems" key={titleWidth}>
              <Skeleton className="screenSkeleton__cardTitle" style={{ width: titleWidth }} />
              {Array.from({ length: 3 }, (_, index) => (
                <div className="screenSkeleton__linkedRow" key={index}>
                  <Skeleton style={{ width: `${52 + ((index + section) % 3) * 12}%` }} />
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="issueRail">
          <div className="issueRail__group">
            {["68px", "128px", "104px", "96px"].map((width) => (
              <div className="issueRail__row" key={width}>
                <Skeleton style={{ width }} />
              </div>
            ))}
          </div>
          {/* Copy prompt and Archive always render; Create pull request depends
              on the repository, which is not known until the issue loads. */}
          <div className="issueRail__actions">
            {[0, 1].map((index) => (
              <Skeleton className="screenSkeleton__railAction" key={index} />
            ))}
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}

export function InvestigationDetailSkeleton() {
  return (
    <LoadingRegion className="investigationPage screenSkeleton screenSkeleton--investigation" label="Loading investigation…">
      <header className="investigationHero">
        <Skeleton className="screenSkeleton__back" style={{ width: "112px" }} />
        <div className="investigationHero__title">
          <Skeleton className="screenSkeleton__title" style={{ width: "min(590px, 72vw)" }} />
          <Skeleton className="screenSkeleton__badge" style={{ width: "76px" }} />
        </div>
        <Skeleton style={{ width: "280px" }} />
      </header>

      <div className="investigationPage__body">
        <Panel className="screenSkeleton__investigationCard" padding="default" surface="raised">
          <Skeleton className="screenSkeleton__cardTitle" style={{ width: "200px" }} />
          <Skeleton style={{ width: "92%" }} />
          <Skeleton style={{ width: "68%" }} />
        </Panel>
        <Panel className="screenSkeleton__investigationCard" padding="default">
          <Skeleton className="screenSkeleton__cardTitle" style={{ width: "126px" }} />
          <Skeleton style={{ width: "78%" }} />
          <Skeleton style={{ width: "54%" }} />
        </Panel>
        <section className="screenSkeleton__trace">
          <header>
            <Skeleton className="screenSkeleton__sectionTitle" style={{ width: "76px" }} />
            <Skeleton style={{ width: "58px" }} />
          </header>
          {Array.from({ length: 4 }, (_, index) => (
            <div className="screenSkeleton__traceRow" key={index}>
              <Skeleton variant="circle" />
              <div>
                <Skeleton style={{ width: `${38 + index * 11}%` }} />
                <Skeleton style={{ width: index % 2 ? "74%" : "88%" }} />
              </div>
            </div>
          ))}
        </section>
      </div>
    </LoadingRegion>
  );
}

export function AgentSetupSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton screenSkeleton--setup" label="Loading agent setup…">
      <section className="createAgentHeading screenSkeleton__detailHeading">
        <div className="screenSkeleton__headingCopy">
          <Skeleton className="screenSkeleton__title" style={{ width: "230px" }} />
          <Skeleton style={{ width: "520px" }} />
        </div>
      </section>
      <div className="createStepper screenSkeleton__setupBody">
        <div className="screenSkeleton__steps">
          {Array.from({ length: 4 }, (_, index) => (
            <div className="screenSkeleton__step" key={index}>
              <Skeleton variant="circle" />
              <Skeleton style={{ width: `${82 - index * 7}%` }} />
            </div>
          ))}
        </div>
        <Panel className="screenSkeleton__setupPanel" padding="default">
          <Skeleton className="screenSkeleton__sectionTitle" style={{ width: "180px" }} />
          <Skeleton style={{ width: "68%" }} />
          <div className="screenSkeleton__setupChoices">
            <Panel padding="default" surface="raised"><Skeleton style={{ width: "58%" }} /><Skeleton style={{ width: "86%" }} /></Panel>
            <Panel padding="default" surface="raised"><Skeleton style={{ width: "64%" }} /><Skeleton style={{ width: "76%" }} /></Panel>
          </div>
        </Panel>
      </div>
    </LoadingRegion>
  );
}

export function IntegrationSettingsSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton screenSkeleton--integrations" label="Loading integrations…">
      <div className="integrationRows">
        {["featured", "secondary"].map((row) => (
          <div className={`integrationRow${row === "featured" ? " integrationRow--featured" : ""}`} key={row}>
            {Array.from({ length: 2 }, (_, index) => (
              <Panel className="integrationCard screenSkeleton__integrationCard" key={index}>
                <Skeleton variant="circle" />
                <div>
                  <Skeleton className="screenSkeleton__cardTitle" style={{ width: `${42 + index * 13}%` }} />
                  <Skeleton style={{ width: "72%" }} />
                </div>
                <Skeleton className="screenSkeleton__integrationAction" variant="circle" />
              </Panel>
            ))}
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

export function BillingSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton screenSkeleton--billing" label="Loading billing…">
      <section className="billingGrid">
        {Array.from({ length: 2 }, (_, index) => (
          <article className="screenSkeleton__billingCard" key={index}>
            <Skeleton className="screenSkeleton__cardTitle" style={{ width: index === 0 ? "180px" : "92px" }} />
            <Skeleton className="screenSkeleton__billingValue" style={{ width: index === 0 ? "68px" : "148px" }} />
            <Skeleton style={{ width: "88%" }} />
            <Skeleton style={{ width: "64%" }} />
            {index === 1 ? <Skeleton className="screenSkeleton__button" /> : null}
          </article>
        ))}
      </section>
    </LoadingRegion>
  );
}

export function MemberListSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton screenSkeleton--members" label="Loading members…">
      <div className="memberList">
        {Array.from({ length: 3 }, (_, index) => (
          <div className="memberRow screenSkeleton__memberRow" key={index}>
            <Skeleton variant="circle" />
            <span className="screenSkeleton__memberIdentity">
              <Skeleton style={{ width: `${42 + index * 11}%` }} />
              <Skeleton style={{ width: "64%" }} />
            </span>
            <Skeleton className="screenSkeleton__memberRole" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

// Varied widths, so placeholder rows do not read as one solid block.
const lineWidths = ["72%", "56%", "64%", "48%", "60%", "68%"];

function lineWidth(index: number) {
  return lineWidths[index % lineWidths.length]!;
}

export interface SkeletonColumn {
  align?: "left" | "right";
  // What a loaded cell holds: a text line, a line over a muted second line,
  // an avatar beside two lines, a status pill, a checkbox, or nothing.
  cell?: "avatar" | "badge" | "checkbox" | "empty" | "text" | "twoLines";
  header: ReactNode;
  key: string;
  width?: string;
}

function SkeletonCell({ align, cell = "text", index }: Pick<SkeletonColumn, "align" | "cell"> & { index: number }) {
  if (cell === "empty") return null;
  if (cell === "checkbox") return <Skeleton className="tableSkeleton__checkbox" />;
  if (cell === "badge") return <Skeleton className="tableSkeleton__badge" />;
  const lines = (
    <span className={`tableSkeleton__lines${align === "right" ? " tableSkeleton__lines--right" : ""}`}>
      <Skeleton style={{ width: lineWidth(index) }} />
      {cell === "twoLines" || cell === "avatar" ? (
        <Skeleton className="tableSkeleton__secondary" style={{ width: lineWidth(index + 3) }} />
      ) : null}
    </span>
  );
  if (cell !== "avatar") return lines;
  return (
    <span className="tableSkeleton__avatar">
      <Skeleton variant="circle" />
      {lines}
    </span>
  );
}

// A table with the loaded table's columns and placeholder rows, so the page
// keeps its layout when the rows arrive.
export function DataTableSkeleton({
  className = "automationRuns agentListTable",
  columns,
  label,
  rows = 5,
  variant = "workspace",
}: {
  className?: string;
  columns: SkeletonColumn[];
  label: string;
  rows?: number;
  variant?: "workspace" | null;
}) {
  return (
    <LoadingRegion className={className ? `screenSkeleton ${className}` : "screenSkeleton"} label={label}>
      <DataTable<number>
        aria-label={label}
        columns={columns.map((column, columnIndex) => ({
          align: column.align,
          header: column.header,
          key: column.key,
          render: (row) => <SkeletonCell align={column.align} cell={column.cell} index={row + columnIndex} />,
          width: column.width,
        }))}
        getRowKey={(row) => row}
        rows={Array.from({ length: rows }, (_, index) => index)}
        variant={variant ?? undefined}
      />
    </LoadingRegion>
  );
}

export function SkeletonLines({ className, widths }: { className?: string; widths: string[] }) {
  return (
    <div className={className ? `screenSkeleton__lines ${className}` : "screenSkeleton__lines"}>
      {widths.map((width, index) => <Skeleton key={index} style={{ width }} />)}
    </div>
  );
}

// A chart, a dashboard widget or a usage graph that is still loading. A
// percentage height fills the container, which needs a height of its own.
export function ChartSkeleton({ className, height, label }: { className?: string; height?: number | string; label: string }) {
  return (
    <LoadingRegion className={className ? `screenSkeleton screenSkeleton--chart ${className}` : "screenSkeleton screenSkeleton--chart"} label={label}>
      <Skeleton className="screenSkeleton__chart" style={height === undefined ? undefined : { height }} />
    </LoadingRegion>
  );
}

interface PageHeaderSkeletonProps {
  // Widths of the buttons at the end of the title row.
  actions?: string[];
  crumbs?: string[];
  meta?: string[];
  title?: string;
}

// The breadcrumb, title row and meta lines most detail pages open with.
export function PageHeaderSkeleton({
  actions = [],
  crumbs = ["72px", "120px"],
  meta = [],
  title = "260px",
}: PageHeaderSkeletonProps) {
  return (
    <header className="automationCreate__header">
      <div className="automationCreate__breadcrumb">
        {crumbs.map((width, index) => <Skeleton className="automationSkeleton__small" key={index} style={{ width }} />)}
      </div>
      <div className="dashboardPage__titleRow">
        <Skeleton className="automationSkeleton__title" style={{ width: title }} />
        <span className="automationCreate__spacer" />
        {actions.map((width, index) => <Skeleton className="pageSkeleton__button" key={index} style={{ width }} />)}
      </div>
      {meta.map((width, index) => <Skeleton className="automationSkeleton__small" key={index} style={{ width }} />)}
    </header>
  );
}

// A white card with an optional heading and text lines.
export function PanelSkeleton({ children, title }: { children?: ReactNode; title?: string }) {
  return (
    <div className="pageSkeleton__panel">
      {title ? <Skeleton className="pageSkeleton__heading" style={{ width: title }} /> : null}
      {children}
    </div>
  );
}

// A labelled form field.
function FieldSkeleton({ label = "96px" }: { label?: string }) {
  return (
    <div className="pageSkeleton__field">
      <Skeleton className="automationSkeleton__small" style={{ width: label }} />
      <Skeleton className="pageSkeleton__input" />
    </div>
  );
}

// The page shape behind the telemetry gate, before the workspace is known to
// read telemetry: the toolbar, then a table.
export function TelemetryPageSkeleton({ label = "Loading telemetry…" }: { label?: string }) {
  return (
    <LoadingRegion className="screenSkeleton" label={label}>
      <div className="telemetryPage">
        <div className="telemetryPage__toolbar">
          {["148px", "120px", "220px"].map((width) => <Skeleton className="pageSkeleton__control" key={width} style={{ width }} />)}
        </div>
        <TableRowsSkeleton />
      </div>
    </LoadingRegion>
  );
}

// Workspace table rows without a region of their own, for skeletons that
// already announce their loading state.
function TableRowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="pageSkeleton__table">
      {Array.from({ length: rows }, (_, index) => (
        <div className="pageSkeleton__tableRow" key={index}>
          <Skeleton style={{ width: lineWidth(index) }} />
          <Skeleton style={{ width: "64px" }} />
          <Skeleton style={{ width: "48px" }} />
        </div>
      ))}
    </div>
  );
}

// The log and trace explorers: the search bar, the volume chart, then the
// filters beside the results.
export function ExplorerSkeleton({ label }: { label: string }) {
  return (
    <LoadingRegion className="screenSkeleton" label={label}>
      <div className="pageSkeleton__stack">
        <div className="explorerToolbar">
          <Skeleton className="pageSkeleton__control" style={{ flex: "1 1 auto" }} />
        </div>
        <section className="explorerVolume">
          <Skeleton className="automationSkeleton__small" style={{ width: "160px" }} />
          <Skeleton className="screenSkeleton__chart" style={{ height: "64px" }} />
        </section>
        <div className="explorerBody">
          <div className="explorerFacets">
            {["40px", "52px"].map((title) => (
              <div className="pageSkeleton__stack" key={title}>
                <Skeleton className="automationSkeleton__small" style={{ width: title }} />
                <ListSkeleton rows={3} />
              </div>
            ))}
          </div>
          <TableRowsSkeleton rows={8} />
        </div>
      </div>
    </LoadingRegion>
  );
}

export function TelemetryOverviewSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton" label="Loading overview…">
      <div className="pageSkeleton__stack pageSkeleton__stack--overview">
        <div className="telOverviewSection">
          <Skeleton className="pageSkeleton__heading" style={{ width: "72px" }} />
          <Skeleton className="automationSkeleton__small" style={{ width: "132px" }} />
        </div>
        {["128px", "96px"].map((name) => (
          <section className="telOverviewTray" key={name}>
            <header className="telOverviewTray__label">
              <Skeleton className="automationSkeleton__small" style={{ width: name }} />
              <Skeleton className="automationSkeleton__small" style={{ width: "72px" }} />
            </header>
            <div className="telOverviewTray__card">
              <div className="telOverviewSignals">
                {[0, 1].map((signal) => (
                  <section className="telOverviewSignal" key={signal}>
                    <Skeleton className="automationSkeleton__small" style={{ width: "44px" }} />
                    <div className="telOverviewSignal__stats">
                      {[0, 1, 2].map((stat) => (
                        <div className="telOverviewStat" key={stat}>
                          <Skeleton className="automationSkeleton__small" style={{ width: "44px" }} />
                          <Skeleton className="pageSkeleton__statValue" style={{ width: "52px" }} />
                        </div>
                      ))}
                    </div>
                    <Skeleton className="pageSkeleton__pills" />
                  </section>
                ))}
              </div>
              <ul className="telOverviewRows">
                <li className="telOverviewRow">
                  <span className="telOverviewRow__icon"><Skeleton className="automationSkeleton__icon" variant="circle" /></span>
                  <Skeleton style={{ width: "36%" }} />
                </li>
              </ul>
            </div>
          </section>
        ))}
      </div>
    </LoadingRegion>
  );
}

// Spans indented under their parents, each bar starting after the last.
const waterfallRows = [
  { depth: 0, left: 0, name: "46%", width: 100 },
  { depth: 1, left: 2, name: "52%", width: 34 },
  { depth: 2, left: 4, name: "40%", width: 18 },
  { depth: 1, left: 38, name: "58%", width: 46 },
  { depth: 2, left: 40, name: "44%", width: 22 },
  { depth: 2, left: 64, name: "50%", width: 16 },
  { depth: 1, left: 86, name: "38%", width: 12 },
];

export function TraceWaterfallSkeleton() {
  return (
    <div className="traceWaterfall">
      <div className="traceWaterfall__axis">
        <span className="traceWaterfall__name"><Skeleton style={{ width: "40px" }} /></span>
        <span className="traceWaterfall__track" />
        <span />
      </div>
      <ul className="traceWaterfall__rows">
        {waterfallRows.map((row, index) => (
          <li key={index}>
            <div className="traceWaterfall__row pageSkeleton__waterfallRow">
              <span className="traceWaterfall__name" style={{ paddingLeft: `${row.depth * 14}px` }}>
                <Skeleton style={{ width: row.name }} />
              </span>
              <span className="traceWaterfall__track">
                <Skeleton className="pageSkeleton__span" style={{ left: `${row.left}%`, width: `${row.width}%` }} />
              </span>
              <span className="traceWaterfall__duration"><Skeleton style={{ width: "40px", marginLeft: "auto" }} /></span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TraceDetailSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton" label="Loading trace…">
      <div className="pageSkeleton__stack">
        <PageHeaderSkeleton crumbs={["44px", "64px"]} meta={["min(520px, 80%)"]} title="240px" />
        <TraceWaterfallSkeleton />
      </div>
    </LoadingRegion>
  );
}

// The trace drawer's meta line and waterfall.
export function TraceDrawerSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton" label="Loading trace…">
      <div className="pageSkeleton__stack">
        <Skeleton className="automationSkeleton__small" style={{ width: "min(460px, 80%)" }} />
        <TraceWaterfallSkeleton />
      </div>
    </LoadingRegion>
  );
}

export function DashboardSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton screenSkeleton--fill" label="Loading dashboard…">
      <div className="dashboardPage">
        <header className="dashboardPage__controls">
          <div className="dashboardPage__column automationCreate__header">
            <div className="automationCreate__breadcrumb">
              <Skeleton className="automationSkeleton__small" style={{ width: "72px" }} />
              <Skeleton className="automationSkeleton__small" style={{ width: "112px" }} />
            </div>
            <div className="dashboardPage__titleRow">
              <Skeleton className="automationSkeleton__title" style={{ width: "200px" }} />
              <span className="automationCreate__spacer" />
              <Skeleton className="pageSkeleton__button" style={{ width: "220px" }} />
              <Skeleton className="pageSkeleton__button" style={{ width: "28px" }} />
            </div>
          </div>
        </header>
        <div className="dashboardPage__canvas">
          <div className="dashboardPage__column">
            <div className="dashboardPage__toolbar">
              <span className="automationCreate__spacer" />
              <Skeleton className="pageSkeleton__button" style={{ width: "104px" }} />
            </div>
            <div className="pageSkeleton__widgets">
              {["136px", "104px", "120px", "88px"].map((title) => (
                <article className="dashboardWidget" key={title}>
                  <header className="dashboardWidget__header">
                    <Skeleton className="automationSkeleton__small" style={{ width: title }} />
                  </header>
                  <div className="dashboardWidget__body">
                    <Skeleton className="screenSkeleton__chart pageSkeleton__chartFill" />
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}

// The alert and activation pages: header, summary beside the properties,
// then the chart.
export function AlertDetailSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton" label="Loading alert…">
      <div className="alertPage">
        <PageHeaderSkeleton actions={["96px", "84px"]} crumbs={["44px", "120px"]} title="220px" />
        <div className="alertOverview">
          <div className="alertOverview__copy">
            <SkeletonLines widths={["92%", "64%"]} />
            <SkeletonLines widths={["132px", "78%"]} />
          </div>
          <aside className="alertProperties">
            <SkeletonLines widths={["84px", "72%", "64%", "56%"]} />
          </aside>
        </div>
        <section className="alertChart">
          <Skeleton className="pageSkeleton__heading" style={{ width: "104px" }} />
          <Skeleton className="screenSkeleton__chart" />
        </section>
      </div>
    </LoadingRegion>
  );
}

// An agent's settings tab: the input, context and output sections.
export function AgentSettingsSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton" label="Loading agent settings…">
      <div className="createAgentForm agentEditor">
        {["48px", "64px", "56px"].map((title) => (
          <section className="createSection" key={title}>
            <header>
              <Skeleton className="pageSkeleton__heading" style={{ width: title }} />
              <Skeleton className="tableSkeleton__secondary" style={{ width: "min(320px, 80%)" }} />
            </header>
            <div className="createSection__body">
              <PanelSkeleton>
                <SkeletonLines widths={["40%", "72%"]} />
              </PanelSkeleton>
            </div>
          </section>
        ))}
      </div>
    </LoadingRegion>
  );
}

// A form page: header, then labelled fields in sections.
export function FormPageSkeleton({ className, label }: { className: string; label: string }) {
  return (
    <LoadingRegion className="screenSkeleton" label={label}>
      <div className={className}>
        <PageHeaderSkeleton actions={["64px", "104px"]} crumbs={["72px", "96px"]} title="200px" />
        <div className="pageSkeleton__form">
          <FieldSkeleton label="72px" />
          {["128px", "112px"].map((title) => (
            <section className="pageSkeleton__formSection" key={title}>
              <Skeleton className="pageSkeleton__heading" style={{ width: title }} />
              <FieldSkeleton />
              <FieldSkeleton label="120px" />
              <FieldSkeleton label="80px" />
            </section>
          ))}
        </div>
      </div>
    </LoadingRegion>
  );
}

export function ErrorIssueSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton" label="Loading error…">
      <div className="errorIssue syntheticCheck">
        <PageHeaderSkeleton actions={["72px", "80px"]} crumbs={["44px", "96px"]} title="min(420px, 60%)" />
        <section className="errorIssue__overview">
          <SkeletonLines widths={["94%", "70%", "180px"]} />
          <SkeletonLines widths={["72%", "88%", "64%", "80%"]} />
        </section>
        <PanelSkeleton title="96px">
          <Skeleton className="screenSkeleton__chart" style={{ height: "140px" }} />
        </PanelSkeleton>
        <PanelSkeleton title="112px">
          <SkeletonLines widths={["88%", "74%", "92%", "60%"]} />
        </PanelSkeleton>
      </div>
    </LoadingRegion>
  );
}

export function SyntheticCheckSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton" label="Loading check…">
      <div className="syntheticCheck">
        <PageHeaderSkeleton
          actions={["168px", "60px", "64px"]}
          crumbs={["108px", "120px"]}
          meta={["min(360px, 70%)", "220px"]}
          title="200px"
        />
        <div className="syntheticCheck__stats">
          {[0, 1, 2, 3].map((index) => (
            <PanelSkeleton key={index}>
              <Skeleton className="automationSkeleton__small" style={{ width: "64px" }} />
              <Skeleton className="pageSkeleton__statValue" style={{ width: "72px" }} />
            </PanelSkeleton>
          ))}
        </div>
        <PanelSkeleton title="88px">
          <Skeleton className="screenSkeleton__chart" style={{ height: "160px" }} />
        </PanelSkeleton>
        <PanelSkeleton title="64px">
          <TableRowsSkeleton rows={4} />
        </PanelSkeleton>
      </div>
    </LoadingRegion>
  );
}

export function TelemetrySetupSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <LoadingRegion className="screenSkeleton" label="Loading telemetry sources…">
      <div className="telemetrySetup">
        <Skeleton className="automationSkeleton__small" style={{ width: "80px" }} />
        <SkeletonLines widths={["min(560px, 90%)"]} />
        <ul className="telemetrySources">
          {Array.from({ length: rows }, (_, index) => (
            <li key={index}>
              <div className="telemetrySources__row">
                <Skeleton className="pageSkeleton__icon" />
                <span className="telemetrySources__body">
                  <Skeleton style={{ width: `${96 + (index % 3) * 24}px` }} />
                  <Skeleton className="tableSkeleton__secondary" style={{ width: lineWidth(index) }} />
                </span>
                <span />
                <span />
              </div>
            </li>
          ))}
        </ul>
      </div>
    </LoadingRegion>
  );
}

// A telemetry source's setup steps.
export function TelemetrySourceSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton" label="Loading setup…">
      <div className="pageSkeleton__stack">
        <SkeletonLines widths={["min(600px, 92%)", "min(380px, 60%)"]} />
        <PanelSkeleton title="132px">
          <SkeletonLines widths={["86%", "62%"]} />
          <Skeleton className="pageSkeleton__button" style={{ width: "136px" }} />
        </PanelSkeleton>
      </div>
    </LoadingRegion>
  );
}

export function ScanDetailSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton" label="Loading scan…">
      <div className="pageSkeleton__stack">
        <div className="screenSkeleton__headingCopy">
          <Skeleton className="pageSkeleton__heading" style={{ width: "220px" }} />
          <Skeleton style={{ width: "min(360px, 70%)" }} />
        </div>
        <div className="pageSkeleton__stats">
          {[0, 1, 2, 3, 4].map((index) => (
            <div key={index}>
              <Skeleton className="automationSkeleton__small" style={{ width: "88px" }} />
              <Skeleton className="pageSkeleton__statValue" style={{ width: "40px" }} />
            </div>
          ))}
        </div>
        <Skeleton className="pageSkeleton__heading" style={{ width: "88px" }} />
        <TableRowsSkeleton rows={4} />
      </div>
    </LoadingRegion>
  );
}

export function SuggestionDetailSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton" label="Loading suggestion…">
      <div className="pageSkeleton__stack">
        <div className="automationCreate__breadcrumb">
          <Skeleton className="automationSkeleton__small" style={{ width: "80px" }} />
          <Skeleton className="automationSkeleton__small" style={{ width: "160px" }} />
        </div>
        <div className="dashboardPage__titleRow">
          <Skeleton className="automationSkeleton__title" style={{ width: "min(420px, 60%)" }} />
          <span className="automationCreate__spacer" />
          <Skeleton className="pageSkeleton__button" style={{ width: "80px" }} />
        </div>
        <SkeletonLines widths={["86%", "92%", "70%", "48%"]} />
        <PanelSkeleton title="128px">
          <DiffLinesSkeleton />
        </PanelSkeleton>
      </div>
    </LoadingRegion>
  );
}

const diffWidths = ["38%", "62%", "54%", "70%", "44%", "58%", "32%"];

function DiffLinesSkeleton() {
  return (
    <div className="pageSkeleton__diff">
      {diffWidths.map((width, index) => (
        <Skeleton key={index} style={{ marginLeft: `${(index % 3) * 16}px`, width }} />
      ))}
    </div>
  );
}

// A proposed diff or a pull request's files while the diff viewer loads.
export function DiffSkeleton({ className, label }: { className?: string; label: string }) {
  return (
    <LoadingRegion className={className ? `screenSkeleton ${className}` : "screenSkeleton"} label={label}>
      <DiffLinesSkeleton />
    </LoadingRegion>
  );
}

// An automation's usage cards: the metric, its total and a daily chart.
export function UsageCardsSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton" label="Loading usage…">
      <div className="usageHistory__cards">
        {["96px", "72px"].map((title) => (
          <section className="usageCard" key={title}>
            <header className="usageCard__header">
              <Skeleton className="automationSkeleton__small" style={{ width: title }} />
              <Skeleton className="pageSkeleton__statValue" style={{ width: "88px" }} />
              <Skeleton className="tableSkeleton__secondary" style={{ width: "80%" }} />
            </header>
            <Skeleton className="screenSkeleton__chart" style={{ height: "120px" }} />
          </section>
        ))}
      </div>
    </LoadingRegion>
  );
}

// The rows of a sidebar list, such as explorer filters or a metric list.
export function ListSkeleton({ label, rows = 5 }: { label?: string; rows?: number }) {
  const lines = (
    <div className="pageSkeleton__list">
      {Array.from({ length: rows }, (_, index) => <Skeleton key={index} style={{ width: lineWidth(index) }} />)}
    </div>
  );
  return label ? <LoadingRegion className="screenSkeleton" label={label}>{lines}</LoadingRegion> : lines;
}

// Integration rows with a toggle, as on the tag mode settings.
export function IntegrationRowsSkeleton({ label }: { label: string }) {
  return (
    <LoadingRegion className="screenSkeleton" label={label}>
      {[0, 1, 2].map((index) => (
        <div className="pageSkeleton__integrationRow" key={index}>
          <Skeleton className="pageSkeleton__icon" />
          <span className="tableSkeleton__lines">
            <Skeleton style={{ width: `${120 + index * 28}px` }} />
            <Skeleton className="tableSkeleton__secondary" style={{ width: lineWidth(index + 2) }} />
          </span>
          <Skeleton className="pageSkeleton__toggle" />
        </div>
      ))}
    </LoadingRegion>
  );
}

// The workspace choices on the sign-in and MCP connection cards.
export function WorkspaceListSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton" label="Loading workspaces…">
      <div className="workspaceList">
        {["136px", "104px"].map((width) => (
          <div className="workspaceChoice pageSkeleton__choice" key={width}>
            <Skeleton style={{ width }} />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

// The setup card's content while a step's data loads.
export function CardContentSkeleton({ label }: { label: string }) {
  return (
    <LoadingRegion className="screenSkeleton" label={label}>
      <div className="pageSkeleton__stack">
        <SkeletonLines widths={["64%", "88%", "52%"]} />
        <Skeleton className="pageSkeleton__input" />
      </div>
    </LoadingRegion>
  );
}

// The workspace frame while the session and the workspace load: the sidebar,
// then a page heading over a table. The shell lays out its own children, so
// they are hidden one by one instead of inside one wrapper.
export function AppFrameSkeleton() {
  return (
    <main aria-busy="true" className="appShell appShell--default appShell--workspace" role="status">
      <span className="srOnly">Loading Superlog…</span>
      <div aria-hidden="true" className="globalHeader pageSkeleton__sidebar">
        <Skeleton className="automationSkeleton__icon" />
        <div className="pageSkeleton__nav">
          {[72, 64, 88, 56, 0, 80, 68, 60].map((width, index) =>
            width ? (
              <span className="pageSkeleton__navItem" key={index}>
                <Skeleton className="automationSkeleton__icon" />
                <Skeleton style={{ width: `${width}px` }} />
              </span>
            ) : (
              <Skeleton className="pageSkeleton__navLabel" key={index} />
            ),
          )}
        </div>
      </div>
      <div aria-hidden="true" className="workspaceSurface">
        <div className="workspaceContent">
          <Skeleton className="pageSkeleton__heading" style={{ width: "120px" }} />
          <TableRowsSkeleton />
        </div>
      </div>
    </main>
  );
}
