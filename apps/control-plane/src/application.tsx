import { App } from "./app";
import { BrowserAnalyticsIdentity } from "./components/browser-analytics-identity";
import { BrowserAnalyticsPageviews } from "./components/browser-analytics-pageviews";
import { BrowserMonitoringIdentity } from "./components/browser-monitoring-identity";
import { ConsentManager } from "./components/consent-manager";

// The application inside its router. The browser and the prerender of public
// pages render this same tree, so the browser hydrates the prerendered HTML
// instead of discarding it.
export function Application({ landingSearch }: { landingSearch: string }) {
  return (
    <ConsentManager landingSearch={landingSearch}>
      <BrowserAnalyticsIdentity />
      <BrowserAnalyticsPageviews />
      <BrowserMonitoringIdentity />
      <App />
    </ConsentManager>
  );
}
