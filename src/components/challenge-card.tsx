import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Pill, TokenAmount } from '@/components/ui';
import { type Challenge, type ChallengeStatus, MAX_MEMBERS, statusLabel } from '@/lib/challenges';
import { dayCount, daysFromToday, formatDate, lastDay, relativeDay } from '@/lib/dates';
import { colors, fonts, radius } from '@/theme';

export function StatusPill({ status }: { status: ChallengeStatus }) {
  const tone = status === 'active' || status === 'refereeing' ? 'green' : 'muted';
  return <Pill label={statusLabel(status)} tone={tone} />;
}

/** Where the challenge is in time: "Starts tomorrow", "Day 3 of 14", "Ended Oct 26". */
export function timeline(c: Challenge): string {
  switch (c.status) {
    case 'draft':
    case 'open':
      return `Starts ${relativeDay(c.start_date).toLowerCase()} · ${dayCount(c.length_days)}`;
    case 'active':
    case 'refereeing': {
      const day = daysFromToday(c.start_date) * -1 + 1;
      if (day < 1) return `Starts ${relativeDay(c.start_date).toLowerCase()}`;
      if (day > c.length_days) return 'Waiting for the results';
      return `Day ${day} of ${c.length_days}`;
    }
    case 'settled':
      return `Ended ${formatDate(lastDay(c.start_date, c.length_days))}`;
  }
}

export function ChallengeCard({ challenge }: { challenge: Challenge }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/challenge/${challenge.id}`)}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
      <View style={styles.top}>
        <Text style={styles.title} numberOfLines={2}>
          {challenge.title}
        </Text>
        <StatusPill status={challenge.status} />
      </View>
      <Text style={styles.timeline}>{timeline(challenge)}</Text>
      <View style={styles.bottom}>
        <TokenAmount amount={challenge.stake} />
        <Text style={styles.meta}>stake</Text>
        <Text style={styles.dot}>·</Text>
        <Text style={styles.meta}>
          {challenge.member_count} of {MAX_MEMBERS} members
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.card,
    padding: 20,
    gap: 10,
  },
  pressed: { transform: [{ scale: 0.98 }] },
  top: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  title: { flex: 1, fontFamily: fonts.sansSemiBold, fontSize: 18, color: colors.text },
  timeline: { fontFamily: fonts.sans, fontSize: 14, color: colors.textSecondary },
  bottom: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  meta: { fontFamily: fonts.sans, fontSize: 13, color: colors.textMuted },
  dot: { color: colors.textMuted },
});
