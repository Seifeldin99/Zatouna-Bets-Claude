// Which reminders to schedule (story 9). Pure rules with no phone APIs, so they
// can be checked on their own; reminders.ts turns the plan into notifications.
//
// A member hears from a challenge only on days they still owe a check-in:
// - "daily" at the time they chose in Settings,
// - "last_chance" two hours before their midnight,
// - "grace" at their midnight, while the grace period (story 5.3) still lets
//   them finish the day, when that nudge is switched on.
// Reminders are planned a week ahead and re-planned whenever the app opens or a
// check-in changes, so a day that gets done loses its reminders.
import type { Today } from '@/lib/check-ins';
import { type Ymd, addDays, fromYmd } from '@/lib/dates';

export type ReminderKind = 'daily' | 'last_chance' | 'grace';

export type PlannedReminder = {
  challengeId: string;
  day: Ymd;
  kind: ReminderKind;
  /** When to show it, in ms since the epoch. */
  at: number;
  title: string;
  body: string;
};

/** One challenge you are in, with where you stand today (from my_today). */
export type ReminderChallenge = {
  id: string;
  title: string;
  start_date: Ymd;
  last_day: Ymd;
  today: Today;
};

export type ReminderSettings = {
  /** The daily reminder's time, in minutes after the phone's midnight. */
  minutes: number;
  /** Challenges whose reminders are switched off. */
  off: string[];
};

export const LAST_CHANCE_BEFORE_MS = 2 * 3_600_000;
/** How many days ahead to plan; the plan is refreshed every time the app opens. */
export const DAYS_AHEAD = 7;
/** iPhones keep at most 64 waiting notifications per app; stay under that. */
export const MAX_SCHEDULED = 60;

/** Choices for the daily reminder: every half hour from 5:00 AM to 9:30 PM, before the last-chance one. */
export const EARLIEST_MINUTES = 5 * 60;
export const LATEST_MINUTES = 21 * 60 + 30;
export const DEFAULT_MINUTES = 19 * 60;

/** "7:00 PM" */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Statuses where today's check-in is still missing. */
function stillOwed(status: Today['status']): boolean {
  return status === 'open' || status === 'rejected';
}

function graceText(graceMs: number): string {
  const minutes = Math.round(graceMs / 60_000);
  return minutes === 60 ? 'the next hour' : `the next ${minutes} minutes`;
}

export function planReminders(
  challenges: ReminderChallenge[],
  settings: ReminderSettings,
  now: number,
  options: { graceNudge: boolean },
): PlannedReminder[] {
  const plan: PlannedReminder[] = [];

  for (const c of challenges) {
    const t = c.today;
    if (settings.off.includes(c.id) || t.status === 'out' || t.status === 'ended') continue;

    // The day a check-in now counts for, in the member's own time zone.
    const checkInDay = t.today ?? c.start_date;
    // The member's midnight can differ from the phone's when the two time
    // zones differ; the server's day end says by how much.
    const shift = t.day_ends_at ? Date.parse(t.day_ends_at) - fromYmd(addDays(checkInDay, 1)).getTime() : 0;
    const graceMs =
      t.day_ends_at && t.grace_ends_at ? Math.max(0, Date.parse(t.grace_ends_at) - Date.parse(t.day_ends_at)) : 0;
    const weekDone = t.week !== null && t.week.done >= t.week.required;

    const first = checkInDay > c.start_date ? checkInDay : c.start_date;
    const stop = addDays(checkInDay, DAYS_AHEAD);
    for (let day = first; day <= c.last_day && day < stop; day = addDays(day, 1)) {
      // Today follows its status; later days are owed unless this week is already complete.
      const isToday = day === checkInDay && t.status !== 'not_started';
      const owed = isToday ? stillOwed(t.status) : !(weekDone && t.week !== null && day <= t.week.ends);
      if (!owed) continue;

      const dayStart = fromYmd(day).getTime() + shift;
      const dayEnd = fromYmd(addDays(day, 1)).getTime() + shift;
      const lastChance = dayEnd - LAST_CHANCE_BEFORE_MS;
      const daily = fromYmd(day).getTime() + settings.minutes * 60_000;

      if (daily > now && daily >= dayStart && daily < lastChance) {
        plan.push({
          challengeId: c.id,
          day,
          kind: 'daily',
          at: daily,
          title: c.title,
          body: 'Time to check in. Take your photo before midnight.',
        });
      }
      if (lastChance > now) {
        plan.push({
          challengeId: c.id,
          day,
          kind: 'last_chance',
          at: lastChance,
          title: `${c.title}: 2 hours left`,
          body: 'Check in before midnight so today counts.',
        });
      }
      if (options.graceNudge && graceMs > 0 && dayEnd > now) {
        plan.push({
          challengeId: c.id,
          day,
          kind: 'grace',
          at: dayEnd,
          title: `${c.title}: grace hour`,
          body: `Your day just ended, but a check-in in ${graceText(graceMs)} still counts for it.`,
        });
      }
    }
  }

  return plan.sort((a, b) => a.at - b.at).slice(0, MAX_SCHEDULED);
}
