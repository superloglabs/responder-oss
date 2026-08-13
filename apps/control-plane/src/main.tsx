import "@fontsource-variable/inter";
import * as Sentry from "@sentry/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app";
import { initializeBrowserAnalytics } from "./browser-analytics";
import { initializeBrowserMonitoring } from "./browser-monitoring";
import { BrowserAnalyticsIdentity } from "./components/browser-analytics-identity";
import { BrowserAnalyticsPageviews } from "./components/browser-analytics-pageviews";
import { ApplicationError } from "./components/application-error";
import { BrowserMonitoringIdentity } from "./components/browser-monitoring-identity";
import { rememberXClickId } from "./x-click-id";
import { initializeXPixel } from "./x-pixel";
import "./styles.css";
import "./design-system/design-system.css";
import "./design-system/design-library.css";

initializeBrowserMonitoring();
void initializeBrowserAnalytics();

const root = document.getElementById("root");
if (!root) throw new Error("Root element is missing");

rememberXClickId();
initializeXPixel();

createRoot(root).render(
  <StrictMode>
    <Sentry.ErrorBoundary
      fallback={({ eventId }) => <ApplicationError eventId={eventId} />}
    >
      <BrowserRouter>
        <BrowserAnalyticsIdentity />
        <BrowserAnalyticsPageviews />
        <BrowserMonitoringIdentity />
        <App />
      </BrowserRouter>
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
