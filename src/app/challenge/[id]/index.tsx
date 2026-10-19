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
  type Results,
  MAX_MEMBERS,
  deleteChallenge,
  getChallenge,
  getResults,
  howOften,
  inviteMessage,
  isFirstDayOpen,
  leaveChallenge,
  quitChallenge,
  resultLabel,
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
import { addDays, dayCount, formatDate, formatDateTime, fromYmd, lastDay } from '@/lib/dates';
import { goBack } from '@/lib/navigation';
import { canCallReferee, decisionLabel, timeLeft } from '@/lib/referee';
import { useLoad } from '@/lib/use-load';
import { colors, fonts } from '@/theme';

type Page = {
  details: ChallengeDetails;
  progress: Progress | null;
  /** Your newest attempt for today, or for your last day once it is over. */
  latest: CheckIn | null;
  results: Results | null;
};

/** The challenge, and once it runs, everyone's days, your latest attempt and the results. */
async function loadPage(id: string): Promise<Page> {
  const details = await getChallenge(id);
  const { status, start_date, length_days } = details.challenge;
  if (status === 'draft' || status === 'open') return { details, progress: null, latest: null, results: null };
  const [progress, results] = await Promise.all([getProgress(id), getResults(id)]);
  const mine = progress.members.find((m) => m.mine);
  const last = lastDay(start_date, length_days);
  const day = mine ? (mine.today > last ? last : mine.today) : null;
  const dayStatus = day ? mine?.days.find((d) => d.day === day)?.status : undefined;
  const latest =
    day && dayStatus && dayStatus !== 'open' && dayStatus !== 'none' && dayStatus !== 'future'
      ? await latestCheckIn(id, day)
      : null;
  return { details, progress, latest, results };
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
      {data && <Details page={data} reload={reload} />}
    </Screen>
  );
}

function Details({ page, reload }: { page: Page; reload: () => Promise<void> }) {
  const { details, progress, latest, results } = page;
  const { challenge: c, members, inviteCode } = details;
  const { session } = useAuth();
  const me = session?.user.id;
  const creator = members.find((m) => m.user_id === c.creator_id);
  const isCreator = me === c.creator_id;
  const isMember = members.some((m) => m.user_id === me);
  const mine = progress?.members.find((m) => m.mine) ?? null;
  const progressOf = (userId: string) => progress?.members.find((m) => m.user_id === userId) ?? null;
  const quitOf = (userId: string) => results?.members.find((m) => m.user_id === userId)?.quit ?? false;
  // During the first day people can still join or leave, and the creator can edit or delete.
  const open = isFirstDayOpen(c);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Runs an action; afterwards goes back to the list, or stays and reloads this screen. */
  async function run(action: () => Promise<void>, then: 'back' | 'stay' = 'back') {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      if (then === 'back') {
        goBack();
        return;
      }
      await reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
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

  // From the second day on a member can quit, which forfeits the stake (product story 4.3).
  const canQuit = !!mine && c.status === 'active' && !open && mine.result === 'in_progress' && !mine.out;

  function confirmQuit() {
    Alert.alert(
      'Quit this challenge?',
      `You lose your ${c.stake} tokens: they stay in the pool for the friends who finish. This can't be undone.`,
      [
        { text: 'Stay in', style: 'cancel' },
        { text: 'Quit', style: 'destructive', onPress: () => run(() => quitChallenge(c.id), 'stay') },
      ],
    );
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

      {results && c.status !== 'active' && <ResultsCard c={c} results={results} />}
      {mine && c.status === 'active' && <TodayCard c={c} mine={mine} latest={latest} results={results} />}

      <StatGrid>
        <StatTile label="Stake" value={c.stake} tokens />
        <StatTile label={c.status === 'settled' ? 'Pool' : 'In the pool'} value={c.stake * members.length} tokens />
        <StatTile label="Members" value={`${members.length} of ${MAX_MEMBERS}`} />
        {results && c.status === 'settled' ? (
          <StatTile
            label="Your result"
            value={resultLabel(results.my_result, results.members.find((m) => m.mine)?.quit ?? false)}
            tone={results.my_result === 'forfeited' ? 'red' : 'normal'}
          />
        ) : mine ? (
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
        {results?.settled_at && <InfoRow label="Paid out" value={formatDateTime(results.settled_at)} />}
      </View>

      <View style={styles.section}>
        <SectionLabel>Members</SectionLabel>
        <Card style={styles.members}>
          {members.map((m) => {
            const p = progressOf(m.user_id);
            const r = c.status === 'settled' ? results?.members.find((x) => x.user_id === m.user_id) : undefined;
            return (
              <View key={m.id} style={styles.member}>
                <View style={styles.memberTop}>
                  <Text style={styles.memberName}>
                    {m.display_name}
                    {m.user_id === me ? ' (you)' : ''}
                  </Text>
                  {r ? (
                    <Text style={[styles.memberRole, r.result === 'forfeited' && styles.memberOut]}>
                      {resultLabel(r.result, r.quit)}
                    </Text>
                  ) : p?.out ? (
                    <Text style={[styles.memberRole, styles.memberOut]}>{quitOf(m.user_id) ? 'Quit' : 'Out'}</Text>
                  ) : (
                    m.user_id === c.creator_id && <Text style={styles.memberRole}>Creator</Text>
                  )}
                </View>
                {p && <DayStrip days={p.days} />}
                {p && (
                  <Text style={styles.memberMeta}>
                    {r
                      ? `${dayCount(p.days_done)} done · ${r.payout != null ? `received ${r.payout} tokens` : 'stake lost'}`
                      : `${dayCount(p.days_done)} done · ${p.out ? (quitOf(m.user_id) ? 'quit' : 'too many misses') : missesLeftLabel(p.misses_left)}`}
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

      {canQuit && (
        <View style={styles.section}>
          {actionError && <ErrorText>{actionError}</ErrorText>}
          <Button label="Quit challenge" variant="outline" onPress={confirmQuit} loading={busy} />
          <Hint>{`Quitting forfeits your stake: your ${c.stake} tokens stay in the pool for the friends who finish.`}</Hint>
        </View>
      )}
    </>
  );
}

/** What you owe today, and the way to the camera. Shown while the challenge runs. */
function TodayCard({
  c,
  mine,
  latest,
  results,
}: {
  c: Challenge;
  mine: MemberProgress;
  latest: CheckIn | null;
  results: Results | null;
}) {
  const last = lastDay(c.start_date, c.length_days);
  const status = mine.days.find((d) => d.day === mine.today)?.status;
  const reason = latest?.verdict?.reason;
  const checkIn = () => router.push(`/challenge/${c.id}/check-in`);
  const callReferee = () => latest && router.push(`/challenge/${c.id}/referee?checkIn=${latest.id}`);
  // After your last midnight the referee can still be called for a short while
  // (a server setting; the server has the last word). Judged by the phone's clock.
  const callHoursMs = results ? new Date(results.calls_close_at).getTime() - new Date(results.ends_at).getTime() : 0;
  const myCallsCloseAt = fromYmd(addDays(last, 1)).getTime() + callHoursMs;

  const quit = results?.members.find((m) => m.mine)?.quit ?? false;

  let body: ReactNode;
  if (quit) {
    body = (
      <>
        <Text style={[styles.todayTitle, styles.todayTitleRed]}>You quit this challenge</Text>
        <Text style={styles.todayText}>Your stake stays in the pool for the friends who finish.</Text>
      </>
    );
  } else if (mine.out || mine.result === 'forfeited') {
    body = (
      <>
        <Text style={[styles.todayTitle, styles.todayTitleRed]}>{"You're out of this challenge"}</Text>
        <Text style={styles.todayText}>You missed more days than allowed, so your stake stays in the pool.</Text>
      </>
    );
  } else if (mine.today < c.start_date) {
    body = <Text style={styles.todayText}>{`Starts ${formatDate(c.start_date)}. Nothing to do yet.`}</Text>;
  } else if (mine.today > last) {
    const lastDayLost = latest?.state === 'rejected' && !latest.referee;
    const mayStillCall = lastDayLost && canCallReferee(latest.decided_at, myCallsCloseAt);
    body = (
      <>
        <Text style={styles.todayTitle}>Your last day is over</Text>
        <Text style={styles.todayText}>
          {latest?.referee?.decision === 'open'
            ? `Your last day waits for the referee, who decides within ${timeLeft(latest.referee.expires_at)}.`
            : "The results come once everyone's last day is over and any referee cases are decided."}
        </Text>
        {mayStillCall && (
          <>
            <Text style={styles.todayMeta}>
              {`Your last photo was not accepted${reason ? `: ${reason}` : '.'} You can still call the referee until ${formatDateTime(new Date(myCallsCloseAt).toISOString())}.`}
            </Text>
            <Button label="Call the referee" variant="secondary" onPress={callReferee} />
          </>
        )}
      </>
    );
  } else if (status === 'done') {
    const byReferee = latest?.referee?.decision === 'accepted';
    body = (
      <>
        <Text style={styles.todayTitle}>Done for today</Text>
        {byReferee ? (
          <Text style={styles.todayText}>{`Referee accepted: ${latest?.referee?.reason}`}</Text>
        ) : reason ? (
          <Text style={styles.todayText}>{reason}</Text>
        ) : null}
      </>
    );
  } else if (status === 'referee') {
    body = (
      <>
        <Text style={styles.todayTitle}>Waiting for the referee</Text>
        <Text style={styles.todayText}>
          {latest?.referee?.explanation
            ? `You wrote: ${latest.referee.explanation}`
            : 'The referee is looking at your photo.'}
        </Text>
        <Text style={styles.todayMeta}>
          {`The referee decides within ${latest?.referee ? timeLeft(latest.referee.expires_at) : '48 hours'}; otherwise the day counts. Until then it is not a miss, and you can still retry.`}
        </Text>
        <Button label="Try again" variant="secondary" onPress={checkIn} />
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
    const decided = latest?.referee && latest.referee.decision !== 'open' ? latest.referee : null;
    const mayCallReferee = !!latest && !latest.referee && canCallReferee(latest.decided_at);
    body = (
      <>
        <Text style={[styles.todayTitle, styles.todayTitleRed]}>Not accepted</Text>
        {decided ? (
          <Text style={styles.todayText}>{`${decisionLabel(decided.decision)}: ${decided.reason}`}</Text>
        ) : reason ? (
          <Text style={styles.todayText}>{reason}</Text>
        ) : null}
        <Button label="Try again" onPress={checkIn} />
        {mayCallReferee && <Button label="Call the referee" variant="secondary" onPress={callReferee} />}
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

/** The end of the challenge: waiting for the payout, or who got what (product story 8.4). */
function ResultsCard({ c, results: r }: { c: Challenge; results: Results }) {
  if (r.status !== 'settled') {
    const title =
      r.waiting_for === 'cases'
        ? 'Ended · waiting for the referee'
        : r.waiting_for === 'calls'
          ? 'Ended · a referee call is still possible'
          : 'Ended · paying out';
    const text =
      r.waiting_for === 'cases'
        ? `${r.open_cases === 1 ? 'One referee case is' : `${r.open_cases} referee cases are`} still open. The pool is paid out as soon as it is decided, and by ${formatDateTime(r.pays_out_by)} at the latest.`
        : r.waiting_for === 'calls'
          ? `A last-day photo was not accepted, and its owner can still call the referee until ${formatDateTime(r.calls_close_at)}. The pool is paid out when that passes, or once a case is decided.`
          : r.waiting_for === 'pending'
            ? 'A photo is still being checked. The pool is paid out right after.'
            : 'The pool is paid out within a minute. Pull down to refresh.';
    return (
      <View style={styles.section}>
        <SectionLabel>Results</SectionLabel>
        <Card style={styles.today}>
          <Text style={styles.todayTitle}>{title}</Text>
          <Text style={styles.todayText}>{text}</Text>
        </Card>
      </View>
    );
  }

  const me = r.members.find((m) => m.mine);
  const net = (r.my_payout ?? 0) - c.stake;
  const headline =
    r.my_result === 'finished'
      ? `You finished: ${net >= 0 ? '+' : '−'}${Math.abs(net)} tokens`
      : `You ${me?.quit ? 'quit' : 'forfeited'}: −${c.stake} tokens`;
  const finishers = r.members.filter((m) => m.result === 'finished').length;
  return (
    <View style={styles.section}>
      <SectionLabel>Results</SectionLabel>
      <Card style={styles.results}>
        <Text style={[styles.todayTitle, r.my_result !== 'finished' && styles.todayTitleRed]}>{headline}</Text>
        <Text style={styles.todayText}>
          {finishers === 0
            ? 'Nobody finished, so the whole pool went to the app.'
            : finishers === r.members.length
              ? 'Everyone finished, so everyone got their stake back.'
              : `${finishers === 1 ? 'One finisher' : `${finishers} finishers`} shared the ${r.forfeited ?? 0} forfeited tokens${(r.app_fee ?? 0) > 0 ? ` after the app's ${r.fee_percent}% fee` : ''}.`}
        </Text>
        <View style={styles.resultRows}>
          {r.members.map((m) => (
            <View key={m.member_id} style={styles.resultRow}>
              <Text style={styles.resultName} numberOfLines={1}>
                {m.name}
                {m.mine ? ' (you)' : ''}
              </Text>
              <Text style={[styles.resultLabel, m.result === 'forfeited' && styles.memberOut]}>
                {resultLabel(m.result, m.quit)}
              </Text>
              <Text style={[styles.resultPayout, m.payout == null && styles.resultNone]}>
                {m.payout == null ? '—' : `+${m.payout}`}
              </Text>
            </View>
          ))}
        </View>
        <View>
          <InfoRow label="Pool" value={`${r.pool} tokens`} />
          <InfoRow label="Forfeited" value={`${r.forfeited ?? 0} tokens`} />
          <InfoRow label={`App fee (${r.fee_percent}%)`} value={`${r.app_fee ?? 0} tokens`} />
          {(r.leftover ?? 0) > 0 && <InfoRow label="Rounding leftover" value={`${r.leftover} tokens`} />}
        </View>
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
  results: { gap: 14 },
  resultRows: { gap: 8 },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  resultName: { flex: 1, fontFamily: fonts.sansMedium, fontSize: 15, color: colors.text },
  resultLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: colors.textSecondary,
  },
  resultPayout: { minWidth: 56, textAlign: 'right', fontFamily: fonts.sansBold, fontSize: 15, color: colors.accent },
  resultNone: { color: colors.textMuted },
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
  referee: { backgroundColor: colors.border, borderColor: colors.textSecondary },
  future: { borderColor: colors.border },
});
