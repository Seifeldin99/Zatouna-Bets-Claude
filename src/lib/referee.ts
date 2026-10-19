// The referee: a member asks support to overrule the AI on their own rejected
// check-in; support (the admin during testing) decides with a reason.
import { toError } from '@/lib/challenges';
import { type AiLabel } from '@/lib/check-ins';
import { type Ymd } from '@/lib/dates';
import { supabase } from '@/lib/supabase';

export const EXPLANATION_MAX = 500;
export const REASON_MAX = 500;
/** How long after the verdict the referee can be called (product story 7.1). */
export const REFEREE_WINDOW_HOURS = 24;

export type RefereeDecision = 'open' | 'accepted' | 'rejected';

/** A member's own case, as embedded on their check-in. */
export type RefereeCase = {
  id: string;
  decision: RefereeDecision;
  reason: string;
  explanation: string;
  created_at: string;
};

/** One case as support sees it in the queue. */
export type QueueCase = {
  id: string;
  check_in_id: string;
  challenge_id: string;
  challenge_title: string;
  rule: string;
  member_name: string;
  day: Ymd;
  attempt: number;
  note: string;
  photo_path: string;
  ai_label: AiLabel | null;
  ai_reason: string | null;
  explanation: string;
  decision: RefereeDecision;
  reason: string;
  created_at: string;
  decided_at: string | null;
};

/** True for support and the admin: the people who decide referee cases. */
export async function amSupport(): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_support');
  if (error) throw toError(error);
  return data === true;
}

/** True while the referee can still be called on a verdict given at `decidedAt`. */
export function canCallReferee(decidedAt: string | null): boolean {
  if (!decidedAt) return false;
  return Date.now() - new Date(decidedAt).getTime() < REFEREE_WINDOW_HOURS * 3_600_000;
}

export async function callReferee(checkInId: string, explanation: string): Promise<string> {
  const { data, error } = await supabase.rpc('open_referee_case', {
    p_check_in_id: checkInId,
    p_explanation: explanation.trim(),
  });
  if (error) throw toError(error);
  return data as string;
}

/** Every case, open ones first. Support only. */
export async function refereeQueue(): Promise<QueueCase[]> {
  const { data, error } = await supabase.rpc('referee_queue');
  if (error) throw toError(error);
  return (data ?? []) as QueueCase[];
}

export async function refereeCase(id: string): Promise<QueueCase> {
  const { data, error } = await supabase.rpc('referee_queue', { p_case_id: id });
  if (error) throw toError(error);
  const found = ((data ?? []) as QueueCase[])[0];
  if (!found) throw new Error('This case is gone.');
  return found;
}

export async function decideCase(id: string, accept: boolean, reason: string): Promise<RefereeDecision> {
  const { data, error } = await supabase.rpc('decide_referee_case', {
    p_case_id: id,
    p_accept: accept,
    p_reason: reason.trim(),
  });
  if (error) throw toError(error);
  return data as RefereeDecision;
}

/** A link to the photo that works for a few minutes. */
export async function photoUrl(path: string): Promise<string> {
  const { data, error } = await supabase.storage.from('check-ins').createSignedUrl(path, 300);
  if (error) throw toError(error);
  return data.signedUrl;
}

export function decisionLabel(d: RefereeDecision): string {
  switch (d) {
    case 'open':
      return 'Waiting for the referee';
    case 'accepted':
      return 'Referee accepted';
    case 'rejected':
      return 'Referee rejected';
  }
}

export function aiLabelText(label: AiLabel | null): string {
  switch (label) {
    case 'likely_ok':
      return 'Likely okay';
    case 'unsure':
      return 'Unsure';
    case 'likely_not_ok':
      return 'Likely not okay';
    case 'failed':
      return 'The check failed';
    default:
      return 'No verdict';
  }
}
