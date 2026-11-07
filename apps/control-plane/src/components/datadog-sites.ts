// Datadog sites and the app URL people sign in to on each.
export const DATADOG_SITES = [
  {
    id: "datadoghq.com",
    name: "US1",
    location: "United States",
    appUrl: "https://app.datadoghq.com",
  },
  {
    id: "datadoghq.eu",
    name: "EU1",
    location: "Europe",
    appUrl: "https://app.datadoghq.eu",
  },
  {
    id: "us3.datadoghq.com",
    name: "US3",
    location: "United States",
    appUrl: "https://us3.datadoghq.com",
  },
  {
    id: "us5.datadoghq.com",
    name: "US5",
    location: "United States",
    appUrl: "https://us5.datadoghq.com",
  },
  {
    id: "ap1.datadoghq.com",
    name: "AP1",
    location: "Asia Pacific",
    appUrl: "https://ap1.datadoghq.com",
  },
  {
    id: "ap2.datadoghq.com",
    name: "AP2",
    location: "Asia Pacific",
    appUrl: "https://ap2.datadoghq.com",
  },
  {
    id: "uk1.datadoghq.com",
    name: "UK1",
    location: "United Kingdom",
    appUrl: "https://uk1.datadoghq.com",
  },
] as const;

export type DatadogSiteId = (typeof DATADOG_SITES)[number]["id"];
