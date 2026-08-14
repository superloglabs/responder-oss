import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AuthGate } from "./components/auth-gate";
import { AgentDetailPage } from "./pages/agent-detail";
import { AgentCreatePage } from "./pages/agent-create";
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
  PricingPage,
} from "./edition-pages";
import { SettingsPage } from "./pages/settings";
import { SuperuserUsersPage } from "./pages/superuser-users";
import { WorkspaceSettingsPage } from "./pages/workspace-settings";
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
      <Route element={<BlogIndexPage />} path="/blog" />
      <Route
        element={<BlogArticlePage />}
        path={blogArticlePath}
      />
      {import.meta.env.DEV ? (
        <Route element={<DesignLibraryPage />} path="/_design" />
      ) : null}
      <Route element={<ProtectedApp />}>
        <Route element={<Navigate replace to="/agents" />} path="/app" />
        <Route
          element={<Navigate replace to="/" />}
          path="/invite/:invitationId"
        />
        <Route element={<AgentsPage />} path="/agents" />
        <Route element={<IssuesPage />} path="/issues" />
        <Route element={<IssueDetailPage />} path="/issues/:issueId" />
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
        <Route element={<SuperuserUsersPage />} path="/superuser/users" />
      </Route>
      <Route element={<Navigate replace to="/" />} path="*" />
    </Routes>
  );
}
