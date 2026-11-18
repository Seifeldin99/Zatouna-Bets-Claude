// Reminder notifications (story 9), scheduled on the phone itself: no push
// server, so nothing extra to set up with Apple or Google. Each refresh asks
// the server where you stand, works out the plan (reminder-plan.ts), and
// replaces every waiting reminder with it.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { AndroidImportance, IosAuthorizationStatus } from 'expo-notifications';
import { Platform } from 'react-native';

import { listChallenges } from '@/lib/challenges';
import { type Today, myToday } from '@/lib/check-ins';
import { lastDay } from '@/lib/dates';
import {
  DEFAULT_MINUTES,
  EARLIEST_MINUTES,
  LATEST_MINUTES,
  type ReminderChallenge,
  type ReminderSettings,
  planReminders,
} from '@/lib/reminder-plan';

const CHANNEL_ID = 'reminders';
/** The extra nudge at midnight while the grace hour runs. */
const GRACE_NUDGE = true;

const settingsKey = (userId: string) => `zatouna.reminders.${userId}`;

export async function loadReminderSettings(userId: string): Promise<ReminderSettings> {
  try {
    const raw = await AsyncStorage.getItem(settingsKey(userId));
    const saved = raw ? (JSON.parse(raw) as Partial<ReminderSettings>) : {};
    const minutes =
      typeof saved.minutes === 'number' && saved.minutes >= EARLIEST_MINUTES && saved.minutes <= LATEST_MINUTES
        ? saved.minutes
        : DEFAULT_MINUTES;
    const off = Array.isArray(saved.off) ? saved.off.filter((id): id is string => typeof id === 'string') : [];
    return { minutes, off };
  } catch {
    return { minutes: DEFAULT_MINUTES, off: [] };
  }
}

async function saveReminderSettings(userId: string, settings: ReminderSettings): Promise<void> {
  await AsyncStorage.setItem(settingsKey(userId), JSON.stringify(settings));
}

/** Changes the daily reminder's time for every challenge, then re-plans. */
export async function setReminderTime(userId: string, minutes: number): Promise<void> {
  const settings = await loadReminderSettings(userId);
  const clamped = Math.min(LATEST_MINUTES, Math.max(EARLIEST_MINUTES, minutes));
  await saveReminderSettings(userId, { ...settings, minutes: clamped });
  await refreshReminders(userId);
}

/** Switches one challenge's reminders on or off, then re-plans. */
export async function setChallengeReminders(userId: string, challengeId: string, on: boolean): Promise<void> {
  const settings = await loadReminderSettings(userId);
  const off = settings.off.filter((id) => id !== challengeId);
  await saveReminderSettings(userId, { ...settings, off: on ? off : [...off, challengeId] });
  await refreshReminders(userId);
}

/** How notifications are set for Zatouna on this phone. */
export type NotificationAccess = 'allowed' | 'blocked' | 'not_asked';

export async function notificationAccess(): Promise<NotificationAccess> {
  const p = await Notifications.getPermissionsAsync();
  if (p.granted || p.ios?.status === IosAuthorizationStatus.PROVISIONAL) return 'allowed';
  return p.canAskAgain ? 'not_asked' : 'blocked';
}

/** Android shows nothing (and never asks) until the app has a notification channel. */
async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Check-in reminders',
    description: 'Reminders on days you still owe a check-in.',
    importance: AndroidImportance.HIGH,
  });
}

/** Asks for permission when the phone still allows asking. True when reminders can show. */
export async function askForNotifications(): Promise<boolean> {
  await ensureChannel();
  const access = await notificationAccess();
  if (access === 'allowed') return true;
  if (access === 'blocked') return false;
  const p = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: false, allowSound: true },
  });
  return p.granted || p.ios?.status === IosAuthorizationStatus.PROVISIONAL;
}

/** Removes every waiting reminder (on sign-out). */
export async function clearReminders(): Promise<void> {
  await Notifications.cancelAllScheduledNotificationsAsync();
}

async function sync(userId: string): Promise<void> {
  const [challenges, today, settings] = await Promise.all([
    listChallenges(),
    myToday(),
    loadReminderSettings(userId),
  ]);
  const todayById = new Map<string, Today>(today.map((t) => [t.challenge_id, t]));
  const mine: ReminderChallenge[] = [];
  for (const c of challenges) {
    // Running challenges come with where you stand today. One that hasn't
    // started yet gets its first days planned too, so day 1 is not missed.
    const t: Today | undefined =
      todayById.get(c.id) ??
      (c.status === 'open' ? { challenge_id: c.id, status: 'not_started', misses_left: c.misses_allowed, week: null } : undefined);
    if (t) mine.push({ id: c.id, title: c.title, start_date: c.start_date, last_day: lastDay(c.start_date, c.length_days), today: t });
  }

  const plan = planReminders(mine, settings, Date.now(), { graceNudge: GRACE_NUDGE });
  await Notifications.cancelAllScheduledNotificationsAsync();
  if (plan.length === 0 || !(await askForNotifications())) return;

  for (const r of plan) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: r.title,
        body: r.body,
        sound: 'default',
        data: { url: `/challenge/${r.challengeId}` },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(r.at),
        channelId: CHANNEL_ID,
      },
    });
  }
}

let running: Promise<void> | null = null;
let again = false;

/**
 * Re-plans every reminder from what the server says now. Safe to call often:
 * calls that arrive while one runs are folded into one more run. Problems are
 * logged, never thrown, so a reminder hiccup never breaks a screen.
 */
export function refreshReminders(userId: string): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await sync(userId);
      } while (again);
    } catch (e) {
      console.warn('Could not schedule reminders', e);
    } finally {
      running = null;
    }
  })();
  return running;
}
