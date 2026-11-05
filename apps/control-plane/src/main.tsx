import "@fontsource-variable/inter";
import * as Sentry from "@sentry/react";
import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { reactErrorHandler } from "@superlog/react";
import { BrowserRouter } from "react-router-dom";
import { Application } from "./application";
import { initializeBrowserMonitoring, initializeBrowserTelemetry } from "./browser-monitoring";
import { ApplicationError } from "./components/application-error";
import "./styles.css";
import "./design-system/design-system.css";
import "./design-system/design-library.css";
import "@c15t/react/styles.css";
import { replaceBlockedStorage } from "./blocked-storage";

// Before anything reads storage, so a browser that blocks site data still
// renders the page.
replaceBlockedStorage(window);
initializeBrowserMonitoring();
initializeBrowserTelemetry();
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
        <Application landingSearch={landingSearch} />
      </BrowserRouter>
    </Sentry.ErrorBoundary>
  </StrictMode>
);

// Errors React recovers from, such as hydration mismatches, and errors the
// boundary catches go to browser telemetry once it starts.
const rootOptions = {
  onCaughtError: reactErrorHandler(),
  onRecoverableError: reactErrorHandler(),
};

if (root.hasChildNodes()) {
  hydrateRoot(root, application, rootOptions);
} else {
  createRoot(root, rootOptions).render(application);
}
