// Everything the app asks the server about challenges and invites. Tokens
// only move inside the database functions called here (CLAUDE.md).
import { createURL } from 'expo-linking';

import { daysFromToday, type Ymd } from '@/lib/dates';
import { supabase } from '@/lib/supabase';

export const MAX_MEMBERS = 10;
export const MIN_LENGTH_DAYS = 1;
export const MAX_LENGTH_DAYS = 30;
export const MAX_START_DAYS_AHEAD = 90;

export type ChallengeStatus = 'draft' | 'open' | 'active' | 'refereeing' | 'settled';

export type Challenge = {
  id: string;
  creator_id: string;
  /** The template it was made from, e.g. "pet_cat". */
  template: string;
  title: string;
  rule: string;
  times_per_week: number;
  start_date: Ymd;
  length_days: number;
  stake: number;
  misses_allowed: number;
  status: ChallengeStatus;
  time_zone: string;
  created_at: string;
  member_count: number;
};

export type Member = {
  id: string;
  user_id: string;
  display_name: string;
  joined_at: string;
  result: 'in_progress' | 'finished' | 'forfeited';
};

export type ChallengeDetails = {
  challenge: Challenge;
  members: Member[];
  /** Only the creator receives the code. */
  inviteCode: string | null;
};

export type ChallengeFields = {
  /** The template's key; the server sets the title and the rule from it. */
  template: string;
  timesPerWeek: number;
  startDate: Ymd;
  lengthDays: number;
  stake: number;
  missesAllowed: number;
};

export type InvitePreview = {
  challenge_id: string;
  title: string;
  rule: string;
  times_per_week: number;
  start_date: Ymd;
  length_days: number;
  stake: number;
  misses_allowed: number;
  status: ChallengeStatus;
  member_count: number;
  creator_name: string | null;
  /** Midnight at the end of the first day, in the creator's time zone. */
  join_closes_at: string;
  already_member: boolean;
  can_join: boolean;
  blocker: string | null;
};

const challengeColumns =
  'id, creator_id, template, title, rule, times_per_week, start_date, length_days, stake, misses_allowed, ' +
  'status, time_zone, created_at, members:challenge_members(count)';

type ChallengeRow = Omit<Challenge, 'member_count'> & { members: { count: number }[] };

function fromRow(row: ChallengeRow): Challenge {
  const { members, ...rest } = row;
  return { ...rest, member_count: members[0]?.count ?? 0 };
}

/** Turns the server's lower-case messages ("not enough tokens") into a sentence. */
export function toError(error: { message: string }): Error {
  const text = error.message.trim();
  const sentence = text.charAt(0).toUpperCase() + text.slice(1);
  return new Error(/[.!?]$/.test(sentence) ? sentence : `${sentence}.`);
}

/** Every challenge the signed-in user created or joined, soonest first. */
export async function listChallenges(): Promise<Challenge[]> {
  const { data, error } = await supabase
    .from('challenges')
    .select(challengeColumns)
    .order('start_date')
    .order('created_at');
  if (error) throw toError(error);
  return (data as unknown as ChallengeRow[]).map(fromRow);
}

export async function getChallenge(id: string): Promise<ChallengeDetails> {
  const [challenge, members, invite] = await Promise.all([
    supabase.from('challenges').select(challengeColumns).eq('id', id).maybeSingle(),
    supabase
      .from('challenge_members')
      .select('id, user_id, joined_at, result, profile:profiles(display_name)')
      .eq('challenge_id', id)
      .order('joined_at'),
    supabase.from('invites').select('code').eq('challenge_id', id).maybeSingle(),
  ]);
  if (challenge.error) throw toError(challenge.error);
  if (members.error) throw toError(members.error);
  if (invite.error) throw toError(invite.error);
  if (!challenge.data) throw new Error("This challenge is gone, or you're not in it.");

  type MemberRow = Omit<Member, 'display_name'> & { profile: { display_name: string } | null };
  return {
    challenge: fromRow(challenge.data as unknown as ChallengeRow),
    members: (members.data as unknown as MemberRow[]).map(({ profile, ...m }) => ({
      ...m,
      display_name: profile?.display_name ?? 'Someone',
    })),
    inviteCode: invite.data?.code ?? null,
  };
}

/** Creates the challenge and places the creator's stake. Returns its id. */
export async function createChallenge(f: ChallengeFields, timeZone: string): Promise<string> {
  const { data, error } = await supabase.rpc('create_challenge', {
    p_template: f.template,
    p_times_per_week: f.timesPerWeek,
    p_start_date: f.startDate,
    p_length_days: f.lengthDays,
    p_stake: f.stake,
    p_misses_allowed: f.missesAllowed,
    p_time_zone: timeZone,
  });
  if (error) throw toError(error);
  return data as string;
}

/** Changes the schedule during the first day. The template, title, rule and stake never change. */
export async function updateChallenge(id: string, f: Omit<ChallengeFields, 'stake' | 'template'>): Promise<void> {
  const { error } = await supabase.rpc('update_challenge', {
    p_id: id,
    p_times_per_week: f.timesPerWeek,
    p_start_date: f.startDate,
    p_length_days: f.lengthDays,
    p_misses_allowed: f.missesAllowed,
  });
  if (error) throw toError(error);
}

/** Deletes before the start; every member gets their stake back. */
export async function deleteChallenge(id: string): Promise<void> {
  const { error } = await supabase.rpc('delete_challenge', { p_id: id });
  if (error) throw toError(error);
}

/** Joins the challenge; the stake moves to the pool at once. Returns the membership id. */
export async function joinChallenge(id: string, timeZone: string): Promise<string> {
  const { data, error } = await supabase.rpc('join_challenge', { p_challenge_id: id, p_time_zone: timeZone });
  if (error) throw toError(error);
  return data as string;
}

/** Leaves during the first day; the stake comes back. */
export async function leaveChallenge(id: string): Promise<void> {
  const { error } = await supabase.rpc('leave_challenge', { p_challenge_id: id });
  if (error) throw toError(error);
}

/**
 * True during the first day, while people can still join or leave and the
 * creator can edit or delete. Judged by the phone's date; the server judges
 * by the creator's time zone and has the last word.
 */
export function isFirstDayOpen(c: Pick<Challenge, 'status' | 'start_date'>): boolean {
  return (c.status === 'draft' || c.status === 'open' || c.status === 'active') && daysFromToday(c.start_date) >= 0;
}

export async function previewInvite(code: string): Promise<InvitePreview> {
  const { data, error } = await supabase.rpc('invite_preview', { p_code: code });
  if (error) throw toError(error);
  return data as InvitePreview;
}

/** The signed-in user's tokens: the sum of their wallet's ledger entries. */
export async function myBalance(): Promise<number> {
  const { data, error } = await supabase
    .from('ledger_balances')
    .select('balance')
    .eq('kind', 'wallet')
    .maybeSingle();
  if (error) throw toError(error);
  return Number(data?.balance ?? 0);
}

export function statusLabel(status: ChallengeStatus): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'refereeing':
      return 'Finishing';
    case 'settled':
      return 'Completed';
    default:
      return 'Not started';
  }
}

export function howOften(timesPerWeek: number): string {
  return timesPerWeek === 7 ? 'Every day' : `${timesPerWeek}× a week`;
}

/** Opens the join screen in the app, e.g. zatouna://join/ABC234. */
export function inviteLink(code: string): string {
  return createURL(`join/${code}`);
}

export function inviteMessage(title: string, stake: number, code: string): string {
  return (
    `Join my challenge "${title}" on Zatouna. The stake is ${stake} tokens.\n\n` +
    `Open Zatouna, go to Bets and enter the code ${code}, or open this link: ${inviteLink(code)}`
  );
}
