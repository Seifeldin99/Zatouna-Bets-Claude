import { router, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  Button,
  ErrorText,
  InfoBox,
  InfoRow,
  Loading,
  Notice,
  Screen,
  ScreenHeader,
  StatGrid,
  StatTile,
} from '@/components/ui';
import { MAX_MEMBERS, howOften, previewInvite } from '@/lib/challenges';
import { formatDate, lastDay, relativeDay } from '@/lib/dates';
import { goBack } from '@/lib/navigation';
import { useLoad } from '@/lib/use-load';
import { colors, fonts } from '@/theme';

export default function JoinScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const load = useCallback(() => previewInvite(code), [code]);
  const { data: p, error, loading } = useLoad(load);

  return (
    <Screen>
      <ScreenHeader title="Invitation" onBack={() => goBack()} />
      {error && (
        <>
          <ErrorText>{error}</ErrorText>
          <Text style={styles.text}>Check the code with the friend who sent it. Codes are 6 letters and digits.</Text>
        </>
      )}
      {loading && <Loading />}
      {p && (
        <>
          <View style={styles.heading}>
            <Text style={styles.invited}>{p.creator_name ?? 'A friend'} invites you to</Text>
            <Text style={styles.title}>{p.title}</Text>
            <Text style={styles.timeline}>
              Starts {relativeDay(p.start_date).toLowerCase()} · {p.length_days} days
            </Text>
          </View>

          <StatGrid>
            <StatTile label="Stake to join" value={p.stake} tokens />
            <StatTile label="Members" value={`${p.member_count} of ${MAX_MEMBERS}`} />
            <StatTile label="How often" value={howOften(p.times_per_week)} />
            <StatTile label="Misses allowed" value={p.misses_allowed} />
          </StatGrid>

          <InfoBox sections={[{ label: 'What counts', text: p.rule || 'No rule written yet.' }]} />

          <View>
            <InfoRow label="Starts" value={formatDate(p.start_date)} />
            <InfoRow label="Ends" value={formatDate(lastDay(p.start_date, p.length_days))} />
          </View>

          {p.already_member ? (
            <Button label="Open the challenge" onPress={() => router.replace(`/challenge/${p.challenge_id}`)} />
          ) : p.can_join ? (
            <Notice>
              You can join this challenge. Joining and placing your stake arrive in the next update of the app.
            </Notice>
          ) : (
            <ErrorText>{capitalize(p.blocker ?? 'You cannot join this challenge.')}</ErrorText>
          )}
        </>
      )}
    </Screen>
  );
}

function capitalize(text: string) {
  const s = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

const styles = StyleSheet.create({
  heading: { gap: 8 },
  invited: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: colors.accent,
  },
  title: { fontFamily: fonts.serif, fontSize: 32, lineHeight: 38, color: colors.text },
  timeline: { fontFamily: fonts.sans, fontSize: 14, color: colors.textSecondary },
  text: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 20, color: colors.textSecondary },
});
