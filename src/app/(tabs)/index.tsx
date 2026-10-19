import { router } from 'expo-router';
import { Image, StyleSheet, Text, View } from 'react-native';

import { ChallengeCard } from '@/components/challenge-card';
import { Button, EmptyState, ErrorText, Screen, SectionLabel, TokenBadge } from '@/components/ui';
import { displayNameOf, useAuth } from '@/lib/auth';
import { listChallenges, myBalance } from '@/lib/challenges';
import { useLoad } from '@/lib/use-load';
import { colors, fonts, radius } from '@/theme';

async function loadHome() {
  const [balance, challenges] = await Promise.all([myBalance(), listChallenges()]);
  return { balance, challenges };
}

export default function HomeScreen() {
  const { session } = useAuth();
  const { data, error } = useLoad(loadHome);
  const today = new Date()
    .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    .toUpperCase();

  const challenges = data?.challenges ?? [];
  const active = challenges.filter((c) => c.status === 'active' || c.status === 'refereeing');
  // Won counts settled challenges where you finished; that arrives with settlement in the app.
  const nextUp = [...active, ...challenges.filter((c) => c.status === 'open' || c.status === 'draft')].slice(0, 3);

  return (
    <Screen>
      <View style={styles.header}>
        <View style={styles.brand}>
          <Image source={require('../../../assets/images/icon.png')} style={styles.logo} />
          <Text style={styles.wordmark}>Zatouna</Text>
        </View>
        <TokenBadge balance={data?.balance ?? 0} />
      </View>

      <View style={styles.welcome}>
        <Text style={styles.date}>{today}</Text>
        <Text style={styles.greeting}>
          Welcome back,{'\n'}
          <Text style={styles.greetingName}>{displayNameOf(session)}!</Text>
        </Text>
        <View style={styles.stats}>
          <Stat label="Active" value={active.length} />
          <Stat label="Won" value={0} />
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
          <ChallengeCard key={c.id} challenge={c} />
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
