import { datadogSites, type DatadogSiteId } from "../../../../packages/core/src/integrations/datadog";

export type { DatadogSiteId };

// Where each site's data lives, for the site picker. The sites themselves come
// from core, so a site added there reaches the picker too.
const locations: Partial<Record<DatadogSiteId, string>> = {
  "datadoghq.com": "United States",
  "datadoghq.eu": "Europe",
  "us3.datadoghq.com": "United States",
  "us5.datadoghq.com": "United States",
  "ap1.datadoghq.com": "Asia Pacific",
  "ap2.datadoghq.com": "Asia Pacific",
  "uk1.datadoghq.com": "United Kingdom",
};

export const DATADOG_SITES = datadogSites.map((site) => ({
  id: site.id,
  name: site.name,
  appUrl: site.appUrl,
  location: locations[site.id] ?? site.name,
}));
