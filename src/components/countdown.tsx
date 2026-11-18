// The countdown to your deadline: first to the end of your day, then through
// the grace period if the day is not done by then (product stories 5.3, 5.4).
// It ticks by the phone's clock; the server has the last word on the day.
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { colors, fonts } from '@/theme';

export type DeadlinePhase = 'day' | 'grace' | 'over';

const HOUR = 3_600_000;

function pad(n: number) {
  return String(n).padStart(2, '0');
}

/** "14:32:07" with an hour or more left, "59:59" under an hour, never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Which deadline applies at `now`: the day's end, then its grace period, then none. */
export function phaseAt(
  now: number,
  endsAt: number,
  graceEndsAt: number | null,
): { phase: DeadlinePhase; target: number } {
  if (now < endsAt) return { phase: 'day', target: endsAt };
  if (graceEndsAt !== null && now < graceEndsAt) return { phase: 'grace', target: graceEndsAt };
  return { phase: 'over', target: graceEndsAt ?? endsAt };
}

/** "Grace hour" when the grace period is an hour, as it is by default. */
export function graceName(endsAt: number, graceEndsAt: number | null): string {
  return graceEndsAt !== null && graceEndsAt - endsAt === HOUR ? 'Grace hour' : 'Grace period';
}

export function Countdown({
  endsAt,
  graceEndsAt,
  onPhaseChange,
  compact = false,
}: {
  /** When the day ends (ms since the epoch). */
  endsAt: number;
  /** When its grace period ends; null when the app does not know of one. */
  graceEndsAt: number | null;
  /** Called when the day ends or the grace period runs out, so the screen can ask the server again. */
  onPhaseChange?: () => void;
  /** Digits only, for a list card. */
  compact?: boolean;
}) {
  // The clock lives in state so rendering stays pure; the first tick comes right away.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const state = now === null ? null : phaseAt(now, endsAt, graceEndsAt);
  const phase = state?.phase ?? null;
  const seen = useRef<DeadlinePhase | null>(null);
  useEffect(() => {
    if (phase === null) return;
    if (seen.current !== null && seen.current !== phase) onPhaseChange?.();
    seen.current = phase;
  }, [phase, onPhaseChange]);

  if (now === null || state === null) return null;
  const remaining = state.target - now;
  const urgent = state.phase === 'grace' || remaining < HOUR;
  let text: string;
  if (state.phase === 'over') {
    text = "Time's up";
  } else if (state.phase === 'grace') {
    text = compact
      ? `${graceName(endsAt, graceEndsAt)} · ${formatCountdown(remaining)}`
      : `${graceName(endsAt, graceEndsAt)} · ${formatCountdown(remaining)} left`;
  } else {
    text = compact ? formatCountdown(remaining) : `${formatCountdown(remaining)} left`;
  }
  return (
    <Text
      style={[
        compact ? styles.compact : styles.digits,
        urgent ? styles.urgent : styles.calm,
        state.phase === 'over' && styles.over,
      ]}>
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  digits: { fontFamily: fonts.sansBold, fontSize: 24, fontVariant: ['tabular-nums'] },
  compact: { fontFamily: fonts.sansSemiBold, fontSize: 14, fontVariant: ['tabular-nums'] },
  calm: { color: colors.accent },
  urgent: { color: colors.danger },
  over: { color: colors.textMuted },
});
