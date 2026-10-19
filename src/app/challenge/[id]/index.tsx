import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { type ReactNode, useCallback, useState } from 'react';
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
  type Challenge,
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
import {
  type CheckIn,
  type DayStatus,
  type MemberProgress,
  type Progress,
  getProgress,
  latestCheckIn,
  missesLeftLabel,
  weekLine,
} from '@/lib/check-ins';
import { dayCount, formatDate, lastDay } from '@/lib/dates';
import { goBack } from '@/lib/navigation';
import { useLoad } from '@/lib/use-load';
import { colors, fonts } from '@/theme';

type Page = { details: ChallengeDetails; progress: Progress | null; latest: CheckIn | null };

/** The challenge, and once it runs, everyone's days plus your own latest attempt today. */
async function loadPage(id: string): Promise<Page> {
  const details = await getChallenge(id);
  const { status } = details.challenge;
  if (status === 'draft' || status === 'open') return { details, progress: null, latest: null };
  const progress = await getProgress(id);
  const mine = progress.members.find((m) => m.mine);
  const todayStatus = mine?.days.find((d) => d.day === mine.today)?.status;
  const latest =
    mine && (todayStatus === 'done' || todayStatus === 'rejected' || todayStatus === 'checking')
      ? await latestCheckIn(id, mine.today)
      : null;
  return { details, progress, latest };
}

export default function ChallengeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const load = useCallback(() => loadPage(id), [id]);
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
      {data && <Details page={data} />}
    </Screen>
  );
}

function Details({ page }: { page: Page }) {
  const { details, progress, latest } = page;
  const { challenge: c, members, inviteCode } = details;
  const { session } = useAuth();
  const me = session?.user.id;
  const creator = members.find((m) => m.user_id === c.creator_id);
  const isCreator = me === c.creator_id;
  const isMember = members.some((m) => m.user_id === me);
  const mine = progress?.members.find((m) => m.mine) ?? null;
  const progressOf = (userId: string) => progress?.members.find((m) => m.user_id === userId) ?? null;
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

      {mine && <TodayCard c={c} mine={mine} latest={latest} />}

      <StatGrid>
        <StatTile label="Stake" value={c.stake} tokens />
        <StatTile label="In the pool" value={c.stake * members.length} tokens />
        <StatTile label="Members" value={`${members.length} of ${MAX_MEMBERS}`} />
        {mine ? (
          <StatTile
            label="Misses left"
            value={mine.out ? 'Out' : `${mine.misses_left} of ${c.misses_allowed}`}
            tone={mine.out || mine.misses_left === 0 ? 'red' : 'normal'}
          />
        ) : (
          <StatTile label="Misses allowed" value={c.misses_allowed} />
        )}
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
          {members.map((m) => {
            const p = progressOf(m.user_id);
            return (
              <View key={m.id} style={styles.member}>
                <View style={styles.memberTop}>
                  <Text style={styles.memberName}>
                    {m.display_name}
                    {m.user_id === me ? ' (you)' : ''}
                  </Text>
                  {p?.out ? (
                    <Text style={[styles.memberRole, styles.memberOut]}>Out</Text>
                  ) : (
                    m.user_id === c.creator_id && <Text style={styles.memberRole}>Creator</Text>
                  )}
                </View>
                {p && <DayStrip days={p.days} />}
                {p && (
                  <Text style={styles.memberMeta}>
                    {`${dayCount(p.days_done)} done · ${p.out ? 'too many misses' : missesLeftLabel(p.misses_left)}`}
                  </Text>
                )}
              </View>
            );
          })}
        </Card>
        {progress && (
          <Hint>Friends see whether a day is done or missed, never the photos or the notes.</Hint>
        )}
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

/** What you owe today, and the way to the camera. Shown while the challenge runs. */
function TodayCard({ c, mine, latest }: { c: Challenge; mine: MemberProgress; latest: CheckIn | null }) {
  const last = lastDay(c.start_date, c.length_days);
  const status = mine.days.find((d) => d.day === mine.today)?.status;
  const reason = latest?.verdict?.reason;
  const checkIn = () => router.push(`/challenge/${c.id}/check-in`);

  let body: ReactNode;
  if (mine.out || mine.result === 'forfeited') {
    body = (
      <>
        <Text style={[styles.todayTitle, styles.todayTitleRed]}>{"You're out of this challenge"}</Text>
        <Text style={styles.todayText}>You missed more days than allowed, so your stake stays in the pool.</Text>
      </>
    );
  } else if (mine.today < c.start_date) {
    body = <Text style={styles.todayText}>{`Starts ${formatDate(c.start_date)}. Nothing to do yet.`}</Text>;
  } else if (mine.today > last) {
    body = <Text style={styles.todayText}>All the days are over. The results come with settlement, in a later update.</Text>;
  } else if (status === 'done') {
    body = (
      <>
        <Text style={styles.todayTitle}>Done for today</Text>
        {reason ? <Text style={styles.todayText}>{reason}</Text> : null}
      </>
    );
  } else if (status === 'checking') {
    body = (
      <>
        <Text style={styles.todayTitle}>Your photo is being checked</Text>
        <Text style={styles.todayText}>Pull down to refresh in a moment.</Text>
      </>
    );
  } else if (status === 'rejected') {
    body = (
      <>
        <Text style={[styles.todayTitle, styles.todayTitleRed]}>Not accepted</Text>
        {reason ? <Text style={styles.todayText}>{reason}</Text> : null}
        <Button label="Try again" onPress={checkIn} />
      </>
    );
  } else {
    body = (
      <>
        <Text style={styles.todayTitle}>Not checked in yet today</Text>
        <Text style={styles.todayText}>Take a photo before midnight to make today count.</Text>
        <Button label="Check in" onPress={checkIn} />
      </>
    );
  }

  return (
    <View style={styles.section}>
      <SectionLabel>Today</SectionLabel>
      <Card style={styles.today}>
        {body}
        {!mine.out && mine.week && c.times_per_week < 7 && mine.today >= c.start_date && mine.today <= last && (
          <Text style={styles.todayMeta}>{weekLine(mine.week)}</Text>
        )}
      </Card>
    </View>
  );
}

/** One small square per challenge day: green done, red missed, outlined today, dim ahead. */
function DayStrip({ days }: { days: { day: string; status: DayStatus }[] }) {
  return (
    <View style={styles.strip} accessibilityLabel={`${days.filter((d) => d.status === 'done').length} days done`}>
      {days.map((d) => (
        <View key={d.day} style={[styles.daySquare, dayStyles[d.status]]} />
      ))}
    </View>
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
  today: { gap: 12 },
  todayTitle: { fontFamily: fonts.sansSemiBold, fontSize: 18, color: colors.accent },
  todayTitleRed: { color: colors.danger },
  todayText: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 21, color: colors.text },
  todayMeta: { fontFamily: fonts.sans, fontSize: 13, color: colors.textSecondary },
  members: { gap: 18 },
  member: { gap: 8 },
  memberTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  memberName: { flex: 1, fontFamily: fonts.sansMedium, fontSize: 16, color: colors.text },
  memberRole: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: colors.textMuted,
  },
  memberOut: { color: colors.danger },
  memberMeta: { fontFamily: fonts.sans, fontSize: 13, color: colors.textSecondary },
  strip: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  daySquare: { width: 14, height: 14, borderRadius: 4, borderWidth: 1.5, borderColor: colors.border },
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

const dayStyles = StyleSheet.create<Record<DayStatus, object>>({
  done: { backgroundColor: colors.accent, borderColor: colors.accent },
  none: { backgroundColor: 'rgba(248,113,113,0.55)', borderColor: 'rgba(248,113,113,0.55)' },
  open: { borderColor: colors.accent },
  checking: { borderColor: colors.textSecondary },
  rejected: { borderColor: colors.danger },
  future: { borderColor: colors.border },
});
