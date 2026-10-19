import { useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { Button, Card, ErrorText, Hint, InfoBox, InfoRow, Loading, Screen, ScreenHeader, TextField } from '@/components/ui';
import { formatDate } from '@/lib/dates';
import { goBack } from '@/lib/navigation';
import { REASON_MAX, type QueueCase, aiLabelText, decideCase, decisionLabel, photoUrl, refereeCase } from '@/lib/referee';
import { useLoad } from '@/lib/use-load';
import { colors, fonts, radius } from '@/theme';

async function loadCase(id: string): Promise<{ c: QueueCase; photo: string | null }> {
  const c = await refereeCase(id);
  const photo = await photoUrl(c.photo_path).catch(() => null);
  return { c, photo };
}

/** One referee case for support: the photo, the facts, and Accept or Reject with a reason. */
export default function RefereeCaseScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const load = useCallback(() => loadCase(id), [id]);
  const { data, error, loading, reload } = useLoad(load);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function decide(accept: boolean) {
    setBusy(accept ? 'accept' : 'reject');
    setActionError(null);
    try {
      await decideCase(id, accept, reason);
      await reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const c = data?.c;
  return (
    <Screen keyboardShouldPersistTaps="handled">
      <ScreenHeader title={c?.challenge_title ?? 'Referee case'} onBack={() => goBack('/referee')} />
      {error && <ErrorText>{error}</ErrorText>}
      {loading && <Loading />}
      {data && c && (
        <>
          {data.photo ? (
            <Image source={{ uri: data.photo }} style={styles.photo} accessibilityLabel="The check-in photo" />
          ) : (
            <Card>
              <Text style={styles.missing}>The photo could not be loaded. Pull down to try again.</Text>
            </Card>
          )}
          <View>
            <InfoRow label="Member" value={c.member_name} />
            <InfoRow label="Day" value={`${formatDate(c.day)} · attempt ${c.attempt}`} />
            <InfoRow label="AI said" value={aiLabelText(c.ai_label)} />
          </View>
          <InfoBox
            sections={[
              { label: 'What counts', text: c.rule },
              { label: "The AI's reason", text: c.ai_reason || 'No reason recorded.' },
              { label: "The member's note", text: c.note || 'No note.' },
              { label: 'Why it should count', text: c.explanation },
            ]}
          />
          {c.decision === 'open' ? (
            <View style={styles.decide}>
              <TextField
                label="Your reason (the member reads it)"
                value={reason}
                onChangeText={setReason}
                multiline
                maxLength={REASON_MAX}
                placeholder="E.g. The book is open and the page is readable."
              />
              {actionError && <ErrorText>{actionError}</ErrorText>}
              <Button
                label="Accept: the day counts"
                onPress={() => void decide(true)}
                loading={busy === 'accept'}
                disabled={busy !== null || !reason.trim()}
              />
              <Button
                label="Reject: stays missed"
                variant="outline"
                onPress={() => void decide(false)}
                loading={busy === 'reject'}
                disabled={busy !== null || !reason.trim()}
              />
              <Hint>The decision is final and the member sees your reason right away.</Hint>
            </View>
          ) : (
            <Card style={styles.decided}>
              <Text style={[styles.decision, c.decision === 'rejected' && styles.decisionRejected]}>
                {decisionLabel(c.decision)}
              </Text>
              <Text style={styles.reason}>{c.reason}</Text>
            </Card>
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  photo: { width: '100%', aspectRatio: 3 / 4, borderRadius: radius.card, backgroundColor: colors.surface },
  missing: { fontFamily: fonts.sans, fontSize: 14, color: colors.textSecondary },
  decide: { gap: 12 },
  decided: { gap: 8 },
  decision: { fontFamily: fonts.sansSemiBold, fontSize: 18, color: colors.accent },
  decisionRejected: { color: colors.danger },
  reason: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 21, color: colors.text },
});
