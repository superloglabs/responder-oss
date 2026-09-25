import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AuthGate } from "./components/auth-gate";
import { AgentDetailPage } from "./pages/agent-detail";
import { AgentCreatePage } from "./pages/agent-create";
import { AgentContextStoryboardPage } from "./pages/agent-context-storyboard";
import { AgentsPage } from "./pages/agents";
import { AutomationsPage } from "./pages/automations";
import { AutomationConnectionCompletePage } from "./pages/automation-connection-complete";
import { AutomationCreatePage } from "./pages/automation-create";
import { AutomationDetailPage, AutomationEditRedirect } from "./pages/automation-detail";
import { AutomationRunPage, AutomationTestChatPage } from "./pages/automation-run";
import { BillingPage } from "./pages/billing";
import { DesignLibraryPage } from "./pages/design-library";
import { InvestigationDetailPage } from "./pages/investigation-detail";
import { IssueDetailPage } from "./pages/issue-detail";
import { IssuesPage } from "./pages/issues";
import { ScanDetailPage } from "./pages/scan-detail";
import { ScansPage } from "./pages/scans";
import { editionSeoMetadataForPath } from "./edition-metadata";
import {
  BlogArticlePage,
  BlogIndexPage,
  DpaPage,
  EnterprisePage,
  HomePage,
  PrivacyPage,
  PricingPage,
  ProductUpdateArticlePage,
  SecurityPage,
  SubprocessorsPage,
  TeamPage,
  TermsPage,
} from "./edition-pages";
import { SettingsPage } from "./pages/settings";
import { SuggestionsPage } from "./pages/suggestions";
import { SuperuserUsersPage } from "./pages/superuser-users";
import { WorkspaceSettingsPage } from "./pages/workspace-settings";
import { ModelAccessSettingsPage } from "./pages/model-access-settings";
import { TagModeSettingsPage } from "./pages/tag-mode-settings";
import { blogArticlePath } from "./public-routes";
import { usePageMetadata } from "./use-page-metadata";

function ProtectedApp() {
  return (
    <AuthGate>
      <Outlet />
    </AuthGate>
  );
}

function LegacyBillingRedirect() {
  const { search } = useLocation();
  return <Navigate replace to={{ pathname: "/settings/billing", search }} />;
}

export function App() {
  const { pathname } = useLocation();
  usePageMetadata(editionSeoMetadataForPath(pathname));

  return (
    <Routes>
      <Route element={<HomePage />} path="/" />
      <Route element={<PricingPage />} path="/pricing" />
      <Route element={<EnterprisePage />} path="/enterprise" />
      <Route element={<BlogIndexPage />} path="/blog" />
      <Route element={<TeamPage />} path="/team" />
      <Route element={<PrivacyPage />} path="/privacy" />
      <Route element={<TermsPage />} path="/tos" />
      <Route element={<DpaPage />} path="/dpa" />
      <Route element={<SecurityPage />} path="/security" />
      <Route element={<SubprocessorsPage />} path="/subprocessors" />
      <Route
        element={<BlogArticlePage />}
        path={blogArticlePath}
      />
      <Route element={<ProductUpdateArticlePage />} path="/blog/quieter-incidents-slack-and-connectors" />
      {import.meta.env.DEV ? (
        <>
          <Route element={<DesignLibraryPage />} path="/_design" />
          <Route
            element={<AgentContextStoryboardPage />}
            path="/_storyboards/agent-context"
          />
          <Route element={<ScansPage />} path="/_storyboards/scans" />
          <Route
            element={<ScanDetailPage />}
            path="/_storyboards/scans/:scanId"
          />
          <Route
            element={<SuggestionsPage />}
            path="/_storyboards/suggestions/:suggestionId?"
          />
        </>
      ) : null}
      <Route element={<ProtectedApp />}>
        <Route element={<Navigate replace to="/agents" />} path="/app" />
        <Route
          element={<Navigate replace to="/" />}
          path="/invite/:invitationId"
        />
        <Route element={<AgentsPage />} path="/agents" />
        <Route element={<AutomationsPage />} path="/automations" />
        <Route element={<AutomationCreatePage />} path="/automations/new" />
        <Route element={<AutomationConnectionCompletePage />} path="/automations/connection-complete" />
        <Route element={<AutomationDetailPage />} path="/automations/:automationId" />
        <Route element={<AutomationEditRedirect />} path="/automations/:automationId/edit" />
        <Route element={<AutomationTestChatPage />} path="/automations/:automationId/test" />
        <Route element={<AutomationRunPage />} path="/automations/:automationId/runs/:runId" />
        <Route element={<IssuesPage />} path="/issues" />
        <Route element={<ScansPage />} path="/scans" />
        <Route element={<ScanDetailPage />} path="/scans/:scanId" />
        <Route element={<IssueDetailPage />} path="/issues/:issueId" />
        <Route element={<SuggestionsPage />} path="/suggestions/:suggestionId?" />
        <Route element={<AgentCreatePage />} path="/agents/new" />
        <Route element={<AgentDetailPage />} path="/agents/:agentId" />
        <Route element={<AgentCreatePage />} path="/agents/:agentId/edit" />
        <Route element={<LegacyBillingRedirect />} path="/billing" />
        <Route
          element={<InvestigationDetailPage />}
          path="/agents/:agentId/investigations/:investigationId"
        />
        <Route element={<SettingsPage />} path="/settings" />
        <Route element={<BillingPage />} path="/settings/billing" />
        <Route element={<WorkspaceSettingsPage />} path="/settings/workspace" />
        <Route element={<TagModeSettingsPage />} path="/settings/tag-mode" />
        <Route element={<ModelAccessSettingsPage />} path="/settings/models" />
        <Route element={<SuperuserUsersPage />} path="/superuser/users" />
      </Route>
      <Route element={<Navigate replace to="/" />} path="*" />
    </Routes>
  );
}
