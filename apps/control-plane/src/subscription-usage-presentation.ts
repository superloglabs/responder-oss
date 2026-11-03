export interface SubscriptionUsageWindow {
  // Milliseconds since the epoch.
  resetsAt: number | null;
  usedPercent: number;
  windowMinutes: number | null;
}

export interface SubscriptionUsageEntry {
  id: string;
  label: string;
  usage: { planType: string | null; windows: SubscriptionUsageWindow[] } | null;
}

const minutesPerDay = 24 * 60;

export function usageWindowLabel(minutes: number | null): string {
  if (!minutes) return "Usage limit";
  if (minutes === 7 * minutesPerDay) return "Weekly limit";
  if (minutes % minutesPerDay === 0) return `${minutes / minutesPerDay}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
}

// The time of day within a day, otherwise the date.
export function usageResetLabel(resetsAt: number | null, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const options: Intl.DateTimeFormatOptions = resetsAt - now < minutesPerDay * 60_000
    ? { hour: "numeric", minute: "2-digit" }
    : { day: "numeric", month: "short" };
  return `Resets ${new Intl.DateTimeFormat(undefined, options).format(new Date(resetsAt))}`;
}

export function usagePlanLabel(planType: string | null): string | null {
  if (!planType || planType === "unknown") return null;
  return planType.charAt(0).toUpperCase() + planType.slice(1);
}
