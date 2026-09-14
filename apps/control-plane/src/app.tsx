import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AuthGate } from "./components/auth-gate";
import { AgentDetailPage } from "./pages/agent-detail";
import { AgentCreatePage } from "./pages/agent-create";
import { AgentContextStoryboardPage } from "./pages/agent-context-storyboard";
import { CodebaseKnowledgePage } from "./pages/codebase-knowledge";
import { CodebaseKnowledgeIndexPage } from "./pages/codebase-knowledge-index";
import { AgentsPage } from "./pages/agents";
import { BillingPage } from "./pages/billing";
import { DesignLibraryPage } from "./pages/design-library";
import { InvestigationDetailPage } from "./pages/investigation-detail";
import { IssueDetailPage } from "./pages/issue-detail";
import { IssuesPage } from "./pages/issues";
import { editionSeoMetadataForPath } from "./edition-metadata";
import {
  BlogArticlePage,
  BlogIndexPage,
  HomePage,
  PrivacyPage,
  PricingPage,
  ProductUpdateArticlePage,
  TeamPage,
  TermsPage,
} from "./edition-pages";
import { SettingsPage } from "./pages/settings";
import { SuperuserUsersPage } from "./pages/superuser-users";
import { WorkspaceSettingsPage } from "./pages/workspace-settings";
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

function LegacyAgentKnowledgeRedirect() {
  return <Navigate replace to="/knowledge" />;
}

export function App() {
  const { pathname } = useLocation();
  usePageMetadata(editionSeoMetadataForPath(pathname));

  return (
    <Routes>
      <Route element={<HomePage />} path="/" />
      <Route element={<PricingPage />} path="/pricing" />
      <Route element={<BlogIndexPage />} path="/blog" />
      <Route element={<TeamPage />} path="/team" />
      <Route element={<PrivacyPage />} path="/privacy" />
      <Route element={<TermsPage />} path="/tos" />
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
        </>
      ) : null}
      <Route element={<ProtectedApp />}>
        <Route element={<Navigate replace to="/agents" />} path="/app" />
        <Route
          element={<Navigate replace to="/" />}
          path="/invite/:invitationId"
        />
        <Route element={<AgentsPage />} path="/agents" />
        <Route element={<CodebaseKnowledgeIndexPage />} path="/knowledge" />
        <Route element={<CodebaseKnowledgePage />} path="/knowledge/:repositoryId" />
        <Route element={<IssuesPage />} path="/issues" />
        <Route element={<IssueDetailPage />} path="/issues/:issueId" />
        <Route element={<AgentCreatePage />} path="/agents/new" />
        <Route element={<AgentDetailPage />} path="/agents/:agentId" />
        <Route element={<LegacyAgentKnowledgeRedirect />} path="/agents/:agentId/knowledge" />
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
        <Route element={<SuperuserUsersPage />} path="/superuser/users" />
      </Route>
      <Route element={<Navigate replace to="/" />} path="*" />
    </Routes>
  );
}
