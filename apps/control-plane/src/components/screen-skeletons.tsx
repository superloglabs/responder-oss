import { Panel, Skeleton } from "../design-system";

function LoadingRegion({
  children,
  className,
  label,
}: {
  children: React.ReactNode;
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
  kind: "agents" | "investigations" | "issues";
  rows?: number;
}) {
  const cellCounts = {
    agents: 6,
    investigations: 4,
    issues: 4,
  } as const;

  return (
    <div className={`screenSkeletonTable screenSkeletonTable--${kind}`}>
      {kind !== "investigations" ? (
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
                {cellIndex === 0 && kind !== "issues" ? (
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

export function IssueListSkeleton() {
  return (
    <LoadingRegion className="screenSkeleton screenSkeleton--list" label="Loading issues…">
      <TableSkeleton kind="issues" />
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
