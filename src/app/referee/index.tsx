import { router } from 'expo-router';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { EmptyState, ErrorText, Loading, Pill, Screen, ScreenHeader } from '@/components/ui';
import { formatDate } from '@/lib/dates';
import { goBack } from '@/lib/navigation';
import { type QueueCase, decisionLabel, refereeQueue } from '@/lib/referee';
import { useLoad } from '@/lib/use-load';
import { colors, fonts, radius } from '@/theme';

/** The support queue: every referee case, open ones first (story 7.2). */
export default function RefereeQueueScreen() {
  const { data, error, loading, refreshing, reload } = useLoad(refereeQueue);

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={reload}
          tintColor={colors.accent}
          colors={[colors.accent]}
          progressBackgroundColor={colors.surface}
        />
      }>
      <ScreenHeader title="Referee queue" onBack={() => goBack('/(tabs)/settings')} />
      {error && <ErrorText>{error}</ErrorText>}
      {loading && <Loading />}
      {data && data.length === 0 && (
        <EmptyState title="No cases" body="When a member contests a rejected check-in, it shows up here." />
      )}
      {data?.map((c) => (
        <CaseRow key={c.id} c={c} />
      ))}
    </Screen>
  );
}

function CaseRow({ c }: { c: QueueCase }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/referee/${c.id}`)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={styles.top}>
        <Text style={styles.title} numberOfLines={1}>
          {c.challenge_title}
        </Text>
        <Pill label={c.decision === 'open' ? 'Waiting' : c.decision} tone={c.decision === 'open' ? 'green' : 'muted'} />
      </View>
      <Text style={styles.meta}>
        {c.member_name} · {formatDate(c.day)} · attempt {c.attempt}
      </Text>
      <Text style={styles.explanation} numberOfLines={2}>
        {c.decision === 'open' ? c.explanation : `${decisionLabel(c.decision)}: ${c.reason}`}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.card,
    padding: 20,
    gap: 8,
  },
  pressed: { transform: [{ scale: 0.98 }] },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { flex: 1, fontFamily: fonts.sansSemiBold, fontSize: 17, color: colors.text },
  meta: { fontFamily: fonts.sans, fontSize: 13, color: colors.textSecondary },
  explanation: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, color: colors.text },
});
