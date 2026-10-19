import { router } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { ChallengeCard } from '@/components/challenge-card';
import { Button, EmptyState, ErrorText, Screen, SectionLabel, TokenBadge } from '@/components/ui';
import { displayNameOf, useAuth } from '@/lib/auth';
import { listChallenges, myBalance, myOutcomes } from '@/lib/challenges';
import { type Today, myToday } from '@/lib/check-ins';
import { useLoad } from '@/lib/use-load';
import { colors, fonts, radius } from '@/theme';

async function loadHome() {
  const [balance, challenges, today, outcomes] = await Promise.all([
    myBalance(),
    listChallenges(),
    myToday(),
    myOutcomes(),
  ]);
  const todayById = new Map<string, Today>(today.map((t) => [t.challenge_id, t]));
  const won = outcomes.filter((o) => o.result === 'finished').length;
  return { balance, challenges, todayById, won };
}

/** Challenges still waiting for today's check-in come first. */
function needsMe(t: Today | undefined): number {
  return t?.status === 'open' || t?.status === 'rejected' ? 0 : 1;
}

export default function HomeScreen() {
  const { session } = useAuth();
  const { data, error } = useLoad(loadHome);
  const today = new Date()
    .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    .toUpperCase();

  const challenges = data?.challenges ?? [];
  const todayOf = (id: string) => data?.todayById.get(id);
  const active = challenges
    .filter((c) => c.status === 'active' || c.status === 'refereeing')
    .sort((a, b) => needsMe(todayOf(a.id)) - needsMe(todayOf(b.id)));
  const nextUp = [...active, ...challenges.filter((c) => c.status === 'open' || c.status === 'draft')].slice(0, 3);

  return (
    <Screen>
      <View style={styles.header}>
        <View style={styles.brand}>
          <Image source={require('../../../assets/images/icon.png')} style={styles.logo} />
          <Text style={styles.wordmark}>Zatouna</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Your tokens and history"
          onPress={() => router.push('/tokens')}
          style={({ pressed }) => pressed && styles.pressed}>
          <TokenBadge balance={data?.balance ?? 0} />
        </Pressable>
      </View>

      <View style={styles.welcome}>
        <Text style={styles.date}>{today}</Text>
        <Text style={styles.greeting}>
          Welcome back,{'\n'}
          <Text style={styles.greetingName}>{displayNameOf(session)}!</Text>
        </Text>
        <View style={styles.stats}>
          <Stat label="Active" value={active.length} />
          <Stat label="Won" value={data?.won ?? 0} />
        </View>
      </View>

      <View style={styles.section}>
        <SectionLabel>Next up</SectionLabel>
        {error && <ErrorText>{error}</ErrorText>}
        {data && nextUp.length === 0 && (
          <>
            <EmptyState
              title="No challenges yet"
              body="Create a challenge, set a stake and invite friends. Or join one with a code from the Bets tab."
            />
            <Button label="Create a challenge" onPress={() => router.push('/challenge/new')} />
          </>
        )}
        {nextUp.map((c) => (
          <ChallengeCard key={c.id} challenge={c} today={todayOf(c.id)?.status} />
        ))}
      </View>
    </Screen>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pressed: { opacity: 0.7 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  logo: { width: 40, height: 40, borderRadius: 12 },
  wordmark: { fontFamily: fonts.serif, fontSize: 22, color: colors.text },
  welcome: {
    backgroundColor: colors.primary,
    borderRadius: radius.panel,
    padding: 24,
    gap: 16,
  },
  date: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 2,
    color: colors.onPrimaryMuted,
  },
  greeting: { fontFamily: fonts.serif, fontSize: 34, lineHeight: 42, color: colors.text },
  greetingName: { fontFamily: fonts.serifBold },
  stats: { flexDirection: 'row', gap: 12, marginTop: 8 },
  stat: {
    flex: 1,
    backgroundColor: colors.onPrimaryTile,
    borderColor: colors.onPrimaryTile,
    borderWidth: 1,
    borderRadius: radius.tile,
    padding: 16,
    gap: 6,
  },
  statLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: colors.onPrimaryMuted,
  },
  statValue: { fontFamily: fonts.serif, fontSize: 28, color: colors.text },
  section: { gap: 12 },
});
