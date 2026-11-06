import { createContext, useContext, type Dispatch, type SetStateAction } from "react";

export interface SignalPreview {
  connections: string[];
  repositories: string[];
  channel: string;
  plan: "Pro" | "Max" | null;
  irrelevant: string[];
}
export const initialPreview: SignalPreview = {
  connections: [], repositories: [], channel: "signal-findings", plan: null, irrelevant: [],
};
export const SignalContext = createContext<{
  preview: SignalPreview;
  setPreview: Dispatch<SetStateAction<SignalPreview>>;
} | null>(null);
export function useSignalPreview() {
  const context = useContext(SignalContext);
  if (!context) throw new Error("Signal preview must be inside SignalLayout");
  return context;
}

export const dailyFindings = [1, 3, 2, 4, 2, 3, 1, 4, 2, 3, 4, 4, 3, 6].map((total, i) => ({
  date: new Date(Date.UTC(2026, 9, 24 + i)),
  total,
  accepted: [1, 2, 1, 3, 1, 2, 1, 3, 1, 2, 3, 3, 2, 2][i],
}));
export function periodData(days: number) {
  if (days <= dailyFindings.length) return dailyFindings.slice(-days);
  return [
    ...Array.from({ length: days - dailyFindings.length }, (_, i) => ({
      date: new Date(Date.UTC(2026, 10, 7 - days + i)), total: 0, accepted: 0,
    })),
    ...dailyFindings,
  ];
}
export function shortDate(date: Date) {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
const examples = [
  ["Checkout requests time out after the payment client retry change", "18 checkout attempts from 11 customers timed out in the last 2 hours.", "Commit a4f29c1 increased the client to three 10-second attempts. Under elevated payment latency, that 30-second retry budget exceeds the gateway’s 20-second deadline.", "checkout-api"],
  ["Webhook retries create duplicate subscription invoices", "Four customers received duplicate invoices after webhook retries.", "The webhook handler inserts an invoice before recording the event ID. A retry during that window processes the same event twice.", "billing-api"],
  ["Connection pool exhaustion blocks account sign-ins", "23 sign-in requests failed while waiting for a database connection.", "The account lookup holds a connection while calling the identity provider. Slow responses consume all available connections.", "auth-api"],
  ["Receipt delivery stops when the email provider rate-limits", "32 order receipts remain undelivered.", "Rate-limited email requests are acknowledged without being returned to the retry queue.", "notification-worker"],
  ["Product image uploads fail for files larger than 10 MB", "Nine image uploads failed for seven customers.", "The proxy body limit is lower than the upload size accepted by the web application.", "media-api"],
  ["A stale cache serves the previous plan after an upgrade", "Five upgraded workspaces still see their previous limits.", "The plan update invalidates the billing cache but leaves the entitlement cache unchanged.", "workspace-api"],
  ["Payment confirmation events are dropped during deploys", "Three completed payments have no confirmation event.", "The worker shuts down before its in-flight event batch is acknowledged.", "payment-worker"],
  ["Search requests time out for large workspaces", "12 searches exceeded the request deadline.", "The new search filter prevents the query from using the workspace index.", "search-api"],
  ["Expired download links prevent invoice exports", "Six invoice exports returned an expired link.", "The export cache outlives the signed download URL it stores.", "billing-api"],
] as const;
export interface Finding {
  id: string; title: string; summary: string; cause: string; service: string;
  severity: 2 | 3; date: Date; found: string; accepted: boolean;
}
let next = 42;
export const sampleFindings: Finding[] = [...dailyFindings].reverse().flatMap((day, dayIndex) =>
  Array.from({ length: day.total }, (_, index) => {
    const id = next--;
    const example = examples[(42 - id) % examples.length];
    return {
      id: `SIG-${String(id).padStart(3, "0")}`, title: example[0], summary: example[1], cause: example[2], service: example[3],
      severity: (42 - id) % 9 < 3 || (42 - id) % 9 === 6 ? 2 : 3,
      date: day.date,
      found: dayIndex === 0 ? ["8m ago", "24m ago", "1h ago", "2h ago", "3h ago", "5h ago"][index]
        : dayIndex === 1 ? "Yesterday" : shortDate(day.date),
      accepted: index >= day.total - day.accepted,
    };
  }),
);
export function findingPrompt(finding: Finding) {
  return `Investigate ${finding.id}: ${finding.title}\n\nImpact: ${finding.summary}\n\nRoot cause: ${finding.cause}\n\nService: ${finding.service}\nSource: Datadog\n\nVerify the evidence and propose a fix with tests.`;
}

