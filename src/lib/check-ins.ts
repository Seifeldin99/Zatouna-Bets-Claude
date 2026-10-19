// Check-ins: the photo-plus-note proof for one day. The server decides which
// day it counts for (the member's own time zone), the attempt number and the
// verdict; the app only takes the photo, uploads it and asks for the result.
import { FunctionsHttpError } from '@supabase/supabase-js';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { toError } from '@/lib/challenges';
import { type Ymd } from '@/lib/dates';
import { supabase } from '@/lib/supabase';

export const NOTE_MAX = 280;
/** The photo is shrunk so its longer side is at most this many pixels before upload. */
const PHOTO_MAX_SIDE = 1280;

/** One day of one member, as friends see it. Only your own days read "checking" or "rejected". */
export type DayStatus = 'done' | 'open' | 'none' | 'future' | 'checking' | 'rejected';

export type Week = {
  starts: Ymd;
  ends: Ymd;
  /** Accepted days this week needs; a short last week needs a fair share. */
  required: number;
  done: number;
  /** Days from today to the end of the week that are still open. */
  days_left: number;
};

export type MemberProgress = {
  member_id: string;
  user_id: string;
  mine: boolean;
  result: 'in_progress' | 'finished' | 'forfeited';
  /** Today in this member's own time zone. */
  today: Ymd;
  days_done: number;
  misses: number;
  misses_left: number;
  out: boolean;
  can_check_in: boolean;
  week: Week | null;
  days: { day: Ymd; status: DayStatus }[];
};

export type Progress = { challenge_id: string; members: MemberProgress[] };

export type TodayStatus = 'out' | 'not_started' | 'ended' | 'done' | 'checking' | 'rejected' | 'open';

export type Today = { challenge_id: string; status: TodayStatus; misses_left: number; week: Week | null };

export type CheckInState = 'pending' | 'accepted' | 'rejected';
export type AiLabel = 'likely_ok' | 'unsure' | 'likely_not_ok' | 'failed';

export type CheckIn = {
  id: string;
  day: Ymd;
  attempt: number;
  note: string;
  state: CheckInState;
  created_at: string;
  verdict: { label: AiLabel; reason: string } | null;
};

export type Verdict = { state: CheckInState; label: AiLabel | null; reason: string };

export type Photo = { uri: string; width: number; height: number };

/** Everyone's days, misses and this week's count for one challenge. Members only. */
export async function getProgress(challengeId: string): Promise<Progress> {
  const { data, error } = await supabase.rpc('challenge_progress', { p_challenge_id: challengeId });
  if (error) throw toError(error);
  return data as Progress;
}

/** Where you stand today in every running challenge, for the Home screen. */
export async function myToday(): Promise<Today[]> {
  const { data, error } = await supabase.rpc('my_today');
  if (error) throw toError(error);
  return (data ?? []) as Today[];
}

/** Your newest attempt for one day, with its verdict. Null when you have none. */
export async function latestCheckIn(challengeId: string, day: Ymd): Promise<CheckIn | null> {
  const { data, error } = await supabase
    .from('check_ins')
    .select('id, day, attempt, note, state, created_at, verdict:ai_checks(label, reason)')
    .eq('challenge_id', challengeId)
    .eq('day', day)
    .order('attempt', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw toError(error);
  if (!data) return null;
  // PostgREST returns a one-to-one embed as an object, but types it loosely.
  const verdict = data.verdict as unknown as CheckIn['verdict'] | CheckIn['verdict'][];
  return { ...data, verdict: Array.isArray(verdict) ? (verdict[0] ?? null) : verdict };
}

/** Shrinks and re-encodes the camera photo so the upload stays small. */
async function shrink(photo: Photo): Promise<string> {
  const portrait = photo.height > photo.width;
  const longest = Math.max(photo.width, photo.height);
  const context = ImageManipulator.manipulate(photo.uri);
  if (longest > PHOTO_MAX_SIDE) {
    context.resize(portrait ? { height: PHOTO_MAX_SIDE } : { width: PHOTO_MAX_SIDE });
  }
  const image = await context.renderAsync();
  try {
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.7 });
    return saved.uri;
  } finally {
    image.release();
  }
}

async function beginCheckIn(challengeId: string, note: string): Promise<{ id: string; photo_path: string }> {
  const { data, error } = await supabase.rpc('begin_check_in', { p_challenge_id: challengeId, p_note: note });
  if (error) throw toError(error);
  return data as { id: string; photo_path: string };
}

async function uploadPhoto(path: string, uri: string): Promise<void> {
  const bytes = await fetch(uri).then((r) => r.arrayBuffer());
  const { error } = await supabase.storage
    .from('check-ins')
    .upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
  if (error) throw toError(error);
}

/** Asks the server function for the verdict. Safe to call again: a decided check-in returns its verdict. */
async function judge(checkInId: string): Promise<Verdict> {
  const { data, error } = await supabase.functions.invoke<Verdict>('judge-check-in', {
    body: { check_in_id: checkInId },
  });
  if (error) {
    let message = error.message;
    if (error instanceof FunctionsHttpError) {
      const body = (await error.context.json().catch(() => null)) as { error?: string } | null;
      if (body?.error) message = body.error;
    }
    throw toError({ message });
  }
  if (!data) throw new Error('The server gave no verdict. Please try again.');
  return data;
}

export type SubmitStage = 'preparing' | 'uploading' | 'checking';

/**
 * The whole check-in: shrink the photo, ask the server for a slot, upload,
 * then wait for the verdict. Takes up to about a minute.
 */
export async function submitCheckIn(
  challengeId: string,
  photo: Photo,
  note: string,
  onStage: (stage: SubmitStage) => void = () => {},
): Promise<Verdict> {
  onStage('preparing');
  const uri = await shrink(photo);
  const slot = await beginCheckIn(challengeId, note.trim());
  onStage('uploading');
  try {
    await uploadPhoto(slot.photo_path, uri);
  } catch (e) {
    // Close the slot now rather than leaving it "being checked" for three minutes.
    await judge(slot.id).catch(() => {});
    throw e;
  }
  onStage('checking');
  return judge(slot.id);
}

/** One line for a challenge card: where you stand today. Null when there is nothing to say. */
export function todayLine(status: TodayStatus): { text: string; tone: 'accent' | 'muted' | 'danger' } | null {
  switch (status) {
    case 'open':
      return { text: 'Not checked in yet today', tone: 'accent' };
    case 'done':
      return { text: 'Done for today', tone: 'muted' };
    case 'checking':
      return { text: 'Your photo is being checked', tone: 'muted' };
    case 'rejected':
      return { text: 'Not accepted: try again', tone: 'danger' };
    case 'out':
      return { text: 'Out: too many misses', tone: 'danger' };
    default:
      return null;
  }
}

export function missesLeftLabel(n: number): string {
  if (n < 0) return 'Too many misses';
  return `${n} ${n === 1 ? 'miss' : 'misses'} left`;
}

export function weekLine(week: Week): string {
  const left = `${week.days_left} ${week.days_left === 1 ? 'day' : 'days'} left`;
  return `This week: ${week.done} of ${week.required} done · ${left}`;
}
