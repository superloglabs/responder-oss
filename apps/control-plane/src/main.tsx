import "@fontsource-variable/inter";
import * as Sentry from "@sentry/react";
import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app";
import { initializeBrowserMonitoring } from "./browser-monitoring";
import { BrowserAnalyticsIdentity } from "./components/browser-analytics-identity";
import { BrowserAnalyticsPageviews } from "./components/browser-analytics-pageviews";
import { ApplicationError } from "./components/application-error";
import { ConsentManager } from "./components/consent-manager";
import { BrowserMonitoringIdentity } from "./components/browser-monitoring-identity";
import "./styles.css";
import "./design-system/design-system.css";
import "./design-system/design-library.css";
import "@c15t/react/styles.css";

initializeBrowserMonitoring();
// Ad click ids arrive in the landing URL; they are stored only after consent.
const landingSearch = window.location.search;

const root = document.getElementById("root");
if (!root) throw new Error("Root element is missing");

const application = (
  <StrictMode>
    <Sentry.ErrorBoundary
      fallback={({ eventId }) => <ApplicationError eventId={eventId} />}
    >
      <BrowserRouter>
        <ConsentManager landingSearch={landingSearch}>
          <BrowserAnalyticsIdentity />
          <BrowserAnalyticsPageviews />
          <BrowserMonitoringIdentity />
          <App />
        </ConsentManager>
      </BrowserRouter>
    </Sentry.ErrorBoundary>
  </StrictMode>
);

if (root.hasChildNodes()) {
  hydrateRoot(root, application);
} else {
  createRoot(root).render(application);
}
