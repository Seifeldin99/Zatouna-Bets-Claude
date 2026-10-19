import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, RefreshControl, Share, StyleSheet, Text, View } from 'react-native';

import { StatusPill, timeline } from '@/components/challenge-card';
import {
  Button,
  Card,
  ErrorText,
  Hint,
  InfoBox,
  InfoRow,
  Loading,
  Screen,
  ScreenHeader,
  SectionLabel,
  StatGrid,
  StatTile,
} from '@/components/ui';
import { useAuth } from '@/lib/auth';
import {
  type ChallengeDetails,
  MAX_MEMBERS,
  deleteChallenge,
  getChallenge,
  howOften,
  inviteMessage,
  isFirstDayOpen,
  leaveChallenge,
  statusLabel,
} from '@/lib/challenges';
import { dayCount, formatDate, lastDay } from '@/lib/dates';
import { goBack } from '@/lib/navigation';
import { useLoad } from '@/lib/use-load';
import { colors, fonts } from '@/theme';

export default function ChallengeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const load = useCallback(() => getChallenge(id), [id]);
  const { data, error, loading, refreshing, reload } = useLoad(load);

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
      <ScreenHeader onBack={() => goBack()} />
      {error && <ErrorText>{error}</ErrorText>}
      {loading && <Loading />}
      {data && <Details details={data} />}
    </Screen>
  );
}

function Details({ details }: { details: ChallengeDetails }) {
  const { challenge: c, members, inviteCode } = details;
  const { session } = useAuth();
  const me = session?.user.id;
  const creator = members.find((m) => m.user_id === c.creator_id);
  const isCreator = me === c.creator_id;
  const isMember = members.some((m) => m.user_id === me);
  // During the first day people can still join or leave, and the creator can edit or delete.
  const open = isFirstDayOpen(c);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      goBack();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  function confirmDelete() {
    Alert.alert(
      'Delete this challenge?',
      members.length > 1
        ? `Everyone in it gets their ${c.stake} tokens back.`
        : `Your ${c.stake} tokens come back to you.`,
      [
        { text: 'Keep it', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => run(() => deleteChallenge(c.id)) },
      ],
    );
  }

  function confirmLeave() {
    Alert.alert('Leave this challenge?', `Your ${c.stake} tokens come back to you.`, [
      { text: 'Stay', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: () => run(() => leaveChallenge(c.id)) },
    ]);
  }

  return (
    <>
      <View style={styles.heading}>
        <Text style={styles.title}>{c.title}</Text>
        <Text style={styles.by}>By {isCreator ? 'you' : (creator?.display_name ?? 'a friend')}</Text>
        <View style={styles.pillRow}>
          <StatusPill status={c.status} />
          <Text style={styles.timeline}>{timeline(c)}</Text>
        </View>
      </View>

      <StatGrid>
        <StatTile label="Stake" value={c.stake} tokens />
        <StatTile label="In the pool" value={c.stake * members.length} tokens />
        <StatTile label="Members" value={`${members.length} of ${MAX_MEMBERS}`} />
        <StatTile label="Misses allowed" value={c.misses_allowed} />
      </StatGrid>

      <InfoBox sections={[{ label: 'What counts', text: c.rule || 'No rule written yet.' }]} />

      <View>
        <InfoRow label="Starts" value={formatDate(c.start_date)} />
        <InfoRow label="Ends" value={formatDate(lastDay(c.start_date, c.length_days))} />
        <InfoRow label="Length" value={dayCount(c.length_days)} />
        <InfoRow label="How often" value={howOften(c.times_per_week)} />
        <InfoRow label="Status" value={statusLabel(c.status)} tone={c.status === 'active' ? 'green' : 'normal'} />
      </View>

      <View style={styles.section}>
        <SectionLabel>Members</SectionLabel>
        <Card style={styles.members}>
          {members.map((m) => (
            <View key={m.id} style={styles.member}>
              <Text style={styles.memberName}>
                {m.display_name}
                {m.user_id === me ? ' (you)' : ''}
              </Text>
              {m.user_id === c.creator_id && <Text style={styles.memberRole}>Creator</Text>}
            </View>
          ))}
        </Card>
      </View>

      {isCreator && open && inviteCode && <Invite code={inviteCode} details={details} />}

      {isCreator && open && (
        <View style={styles.section}>
          {actionError && <ErrorText>{actionError}</ErrorText>}
          <Button label="Edit challenge" variant="secondary" onPress={() => router.push(`/challenge/${c.id}/edit`)} />
          <Button label="Delete challenge" variant="outline" onPress={confirmDelete} loading={busy} />
          <Hint>
            {`You can edit or delete until the end of ${formatDate(c.start_date)}, the first day. After that nothing changes. The stake can't change.`}
          </Hint>
        </View>
      )}

      {!isCreator && isMember && open && (
        <View style={styles.section}>
          {actionError && <ErrorText>{actionError}</ErrorText>}
          <Button label="Leave challenge" variant="outline" onPress={confirmLeave} loading={busy} />
          <Hint>{`You can leave and get your stake back until the end of ${formatDate(c.start_date)}, the first day.`}</Hint>
        </View>
      )}
    </>
  );
}

function Invite({ code, details }: { code: string; details: ChallengeDetails }) {
  const { challenge: c, members } = details;
  const [copied, setCopied] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const full = members.length >= MAX_MEMBERS;

  async function share() {
    setShareError(null);
    try {
      await Share.share({ message: inviteMessage(c.title, c.stake, code) });
    } catch (e) {
      setShareError(e instanceof Error ? e.message : String(e));
    }
  }

  async function copy() {
    await Clipboard.setStringAsync(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <View style={styles.section}>
      <SectionLabel>Invite friends</SectionLabel>
      <Card style={styles.inviteCard}>
        <Text style={styles.code} selectable accessibilityLabel={`Invite code ${code.split('').join(' ')}`}>
          {code}
        </Text>
        <Text style={styles.inviteText}>
          {full
            ? `The challenge is full (${MAX_MEMBERS} members).`
            : `Friends enter this code in Zatouna, under Bets. Up to ${MAX_MEMBERS - members.length} more can join until the end of ${formatDate(c.start_date)}.`}
        </Text>
        {shareError && <ErrorText>{shareError}</ErrorText>}
        <Button label="Share invite" onPress={share} disabled={full} />
        <Button label={copied ? 'Copied!' : 'Copy code'} variant="secondary" onPress={copy} />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  heading: { gap: 8 },
  title: { fontFamily: fonts.serif, fontSize: 32, lineHeight: 38, color: colors.text },
  by: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: colors.accent,
  },
  pillRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  timeline: { fontFamily: fonts.sans, fontSize: 14, color: colors.textSecondary },
  section: { gap: 12 },
  members: { gap: 14 },
  member: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  memberName: { flex: 1, fontFamily: fonts.sansMedium, fontSize: 16, color: colors.text },
  memberRole: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  inviteCard: { gap: 14, alignItems: 'stretch' },
  code: {
    fontFamily: fonts.sansBold,
    fontSize: 36,
    letterSpacing: 8,
    textAlign: 'center',
    color: colors.accent,
  },
  inviteText: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, textAlign: 'center', color: colors.textSecondary },
});
