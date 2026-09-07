import type {
  InvestigationReportSubmission,
  IssueRemediationSubmission,
} from "@responder/core/investigations/report";

interface RepositoryBase {
  branch: string;
  repository: string;
  sha: string;
}

export function attachRepositoryBasesToRemediations(
  remediations: IssueRemediationSubmission[],
  repositories: RepositoryBase[],
): IssueRemediationSubmission[] {
  const repositoryByName = new Map(
    repositories.map((repository) => [repository.repository, repository]),
  );

  return remediations.map((remediation) => {
    if (remediation.type !== "code_change") return remediation;
    return {
      ...remediation,
      changes: remediation.changes.map((change) => {
        const changeWithoutBase = { ...change };
        delete changeWithoutBase.base;
        const repository = change.repository
          ? repositoryByName.get(change.repository)
          : repositories.length === 1
            ? repositories[0]
            : undefined;
        return {
          ...changeWithoutBase,
          ...(repository
            ? { base: { branch: repository.branch, sha: repository.sha } }
            : {}),
        };
      }),
    };
  });
}

export function attachRepositoryBasesToReport(
  report: InvestigationReportSubmission,
  repositories: RepositoryBase[],
): InvestigationReportSubmission {
  return {
    ...report,
    issues: report.issues.map((issue) =>
      issue.resolution === "new"
        ? {
            ...issue,
            remediations: attachRepositoryBasesToRemediations(
              issue.remediations,
              repositories,
            ),
          }
        : issue,
    ),
  };
}
