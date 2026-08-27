const dateFormatterOptions: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "long",
  year: "numeric",
};

function localCalendarDay(value: Date): number {
  return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
}

export function dateGroupLabel(
  value: string,
  now = new Date(),
  locale?: string,
): string {
  const date = new Date(value);
  const daysAgo =
    (localCalendarDay(now) - localCalendarDay(date)) / (24 * 60 * 60 * 1000);

  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";

  return new Intl.DateTimeFormat(locale, dateFormatterOptions).format(date);
}
