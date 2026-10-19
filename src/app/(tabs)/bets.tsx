import { router } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';

import { ChallengeCard } from '@/components/challenge-card';
import {
  Button,
  EmptyState,
  ErrorText,
  IconButton,
  Loading,
  Screen,
  SectionLabel,
  TextField,
  Title,
} from '@/components/ui';
import { type Challenge, type Outcome, listChallenges, myOutcomes } from '@/lib/challenges';
import { useLoad } from '@/lib/use-load';
import { colors } from '@/theme';

const sections: { label: string; statuses: Challenge['status'][] }[] = [
  { label: 'Active', statuses: ['active'] },
  { label: 'Ended', statuses: ['refereeing'] },
  { label: 'Not started', statuses: ['draft', 'open'] },
  { label: 'Completed', statuses: ['settled'] },
];

async function loadBets() {
  const [challenges, outcomes] = await Promise.all([listChallenges(), myOutcomes()]);
  return { challenges, outcomeById: new Map<string, Outcome>(outcomes.map((o) => [o.challenge_id, o])) };
}

export default function BetsScreen() {
  const { data, error, loading, refreshing, reload } = useLoad(loadBets);
  const [code, setCode] = useState('');

  function lookUp() {
    const clean = code.trim().toUpperCase();
    if (!clean) return;
    setCode('');
    router.push(`/join/${clean}`);
  }

  return (
    <Screen
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={reload}
          tintColor={colors.accent}
          colors={[colors.accent]}
          progressBackgroundColor={colors.surface}
        />
      }>
      <View style={styles.header}>
        <Title>Challenges</Title>
        <IconButton
          icon={{ ios: 'plus', android: 'add' }}
          label="New challenge"
          tone="primary"
          onPress={() => router.push('/challenge/new')}
        />
      </View>

      <View style={styles.invite}>
        <View style={styles.inviteField}>
          <TextField
            label="Got an invite code?"
            value={code}
            onChangeText={setCode}
            placeholder="ABC234"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={6}
            onSubmitEditing={lookUp}
            returnKeyType="go"
          />
        </View>
        <View style={styles.inviteButton}>
          <Button label="Look up" variant="secondary" onPress={lookUp} disabled={code.trim().length < 6} />
        </View>
      </View>

      {error && <ErrorText>{error}</ErrorText>}
      {loading && <Loading />}
      {data && data.challenges.length === 0 && (
        <EmptyState
          title="No challenges yet"
          body="Tap + to create one and invite friends, or enter a code a friend sent you."
        />
      )}
      {data &&
        sections.map(({ label, statuses }) => {
          const items = data.challenges.filter((c) => statuses.includes(c.status));
          if (items.length === 0) return null;
          return (
            <View key={label} style={styles.section}>
              <SectionLabel>{label}</SectionLabel>
              {items.map((c) => (
                <ChallengeCard key={c.id} challenge={c} outcome={data.outcomeById.get(c.id)} />
              ))}
            </View>
          );
        })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  invite: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  inviteField: { flex: 1 },
  inviteButton: { width: 110 },
  section: { gap: 12 },
});
