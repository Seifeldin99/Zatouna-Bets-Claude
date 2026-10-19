// Calendar dates the way the app and the server exchange them: "YYYY-MM-DD"
// in the phone's own time zone, never shifted through UTC.

export type Ymd = string;

function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function toYmd(d: Date): Ymd {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromYmd(ymd: Ymd): Date {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function todayYmd(): Ymd {
  return toYmd(new Date());
}

export function addDays(ymd: Ymd, days: number): Ymd {
  const d = fromYmd(ymd);
  d.setDate(d.getDate() + days);
  return toYmd(d);
}

/** Whole days from today to the date; negative once it has passed. */
export function daysFromToday(ymd: Ymd): number {
  const ms = fromYmd(ymd).getTime() - fromYmd(todayYmd()).getTime();
  return Math.round(ms / 86_400_000);
}

/** "Tue, Oct 20" */
export function formatDate(ymd: Ymd): string {
  return fromYmd(ymd).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "Today", "Tomorrow", "In 3 days", "2 days ago" */
export function relativeDay(ymd: Ymd): string {
  const n = daysFromToday(ymd);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  return n > 0 ? `In ${n} days` : `${-n} days ago`;
}

/** The last day of a challenge that starts on `start` and lasts `lengthDays`. */
export function lastDay(start: Ymd, lengthDays: number): Ymd {
  return addDays(start, lengthDays - 1);
}

/** The phone's time zone, as the server expects it (e.g. "America/Toronto"). */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
