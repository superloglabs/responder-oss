import { Link, Navigate } from "react-router-dom";
import "./edition-pages.css";

export function HomePage() {
  return <Navigate replace to="/app" />;
}

export function PricingPage() {
  return <Navigate replace to="/app" />;
}

export function BlogIndexPage() {
  return <Navigate replace to="/app" />;
}

export function BlogArticlePage() {
  return <Navigate replace to="/app" />;
}

export function ProductUpdateArticlePage() {
  return <Navigate replace to="/app" />;
}

export function TeamPage() {
  return <Navigate replace to="/app" />;
}

export function PrivacyPage() {
  return <Navigate replace to="/app" />;
}

export function TermsPage() {
  return <Navigate replace to="/app" />;
}

export function DpaPage() {
  return <Navigate replace to="/app" />;
}

export function SecurityPage() {
  return <Navigate replace to="/app" />;
}

export function SubprocessorsPage() {
  return <Navigate replace to="/app" />;
}

export function SupportPage() {
  return <Navigate replace to="/app" />;
}

export function SmsConsentPage() {
  return <Navigate replace to="/app" />;
}

export function EnterprisePage() {
  return <Navigate replace to="/app" />;
}

export function ChangelogPage() {
  return <Navigate replace to="/app" />;
}

export function IntegrationsPage() {
  return <Navigate replace to="/app" />;
}

export function IntegrationPage() {
  return <Navigate replace to="/app" />;
}

export function ComparisonIndexPage() {
  return <Navigate replace to="/app" />;
}

export function ComparisonPage() {
  return <Navigate replace to="/app" />;
}

export function OpenSourcePage() {
  return <Navigate replace to="/app" />;
}

export function ObservabilityPage() {
  return <Navigate replace to="/app" />;
}

export function ResourcesIndexPage() {
  return <Navigate replace to="/app" />;
}

export function ResourcePage() {
  return <Navigate replace to="/app" />;
}

export function NotFoundPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 px-6">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <p>No page exists at this address.</p>
      <Link className="underline" to="/app">
        Open Superlog
      </Link>
    </main>
  );
}
