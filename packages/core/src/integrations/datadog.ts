export const DATADOG_OAUTH_RESOURCE =
  "https://mcp.datadoghq.com/v1/mcp";

export const datadogSites = [
  {
    id: "datadoghq.com",
    name: "US1",
    appUrl: "https://app.datadoghq.com",
    apiUrl: "https://api.datadoghq.com",
    mcpUrl: "https://mcp.datadoghq.com/v1/mcp",
  },
  {
    id: "datadoghq.eu",
    name: "EU1",
    appUrl: "https://app.datadoghq.eu",
    apiUrl: "https://api.datadoghq.eu",
    mcpUrl: "https://mcp.datadoghq.eu/v1/mcp",
  },
  {
    id: "us3.datadoghq.com",
    name: "US3",
    appUrl: "https://us3.datadoghq.com",
    apiUrl: "https://api.us3.datadoghq.com",
    mcpUrl: "https://mcp.us3.datadoghq.com/v1/mcp",
  },
  {
    id: "us5.datadoghq.com",
    name: "US5",
    appUrl: "https://us5.datadoghq.com",
    apiUrl: "https://api.us5.datadoghq.com",
    mcpUrl: "https://mcp.us5.datadoghq.com/v1/mcp",
  },
  {
    id: "ap1.datadoghq.com",
    name: "AP1",
    appUrl: "https://ap1.datadoghq.com",
    apiUrl: "https://api.ap1.datadoghq.com",
    mcpUrl: "https://mcp.ap1.datadoghq.com/v1/mcp",
  },
  {
    id: "ap2.datadoghq.com",
    name: "AP2",
    appUrl: "https://ap2.datadoghq.com",
    apiUrl: "https://api.ap2.datadoghq.com",
    mcpUrl: "https://mcp.ap2.datadoghq.com/v1/mcp",
  },
  {
    id: "uk1.datadoghq.com",
    name: "UK1",
    appUrl: "https://uk1.datadoghq.com",
    apiUrl: "https://api.uk1.datadoghq.com",
    mcpUrl: "https://mcp.uk1.datadoghq.com/v1/mcp",
  },
] as const;

export type DatadogSite = (typeof datadogSites)[number];
export type DatadogSiteId = DatadogSite["id"];
export type DatadogDatacenter = DatadogSite["name"];

export function getDatadogSite(siteId: string | undefined): DatadogSite {
  if (siteId === undefined) return datadogSites[0];
  const site = datadogSites.find((candidate) => candidate.id === siteId);
  if (!site) throw new Error(`Unsupported Datadog site: ${siteId}`);
  return site;
}
