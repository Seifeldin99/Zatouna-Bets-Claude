import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { Button, Card, ErrorText, Hint, Screen, ScreenHeader, TextField } from '@/components/ui';
import { goBack } from '@/lib/navigation';
import { EXPLANATION_MAX, callReferee } from '@/lib/referee';
import { colors, fonts } from '@/theme';

/** Asks support to overrule the AI on one rejected check-in (story 7.1). */
export default function CallRefereeScreen() {
  const { id, checkIn } = useLocalSearchParams<{ id: string; checkIn: string }>();
  const [explanation, setExplanation] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const back = () => goBack(`/challenge/${id}`);

  async function send() {
    setSending(true);
    setError(null);
    try {
      await callReferee(checkIn, explanation);
      setSent(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <Screen keyboardShouldPersistTaps="handled">
      <ScreenHeader title="Call the referee" back="close" onBack={back} />
      {sent ? (
        <>
          <Card style={styles.center}>
            <Text style={styles.title}>Sent to the referee</Text>
            <Text style={styles.text}>
              Until the decision, that day shows as waiting instead of missed. The decision and its reason will appear
              on the challenge screen.
            </Text>
          </Card>
          <Button label="Done" onPress={back} />
        </>
      ) : (
        <>
          <Text style={styles.text}>
            {"Tell the referee why the photo should count. The referee sees your photo, your note and the AI's reason."}
          </Text>
          <TextField
            label="Your explanation"
            value={explanation}
            onChangeText={setExplanation}
            multiline
            maxLength={EXPLANATION_MAX}
            placeholder="What does the photo show?"
            hint={`${explanation.length} of ${EXPLANATION_MAX} characters`}
          />
          {error && <ErrorText>{error}</ErrorText>}
          <Button label="Send to the referee" onPress={() => void send()} loading={sending} disabled={!explanation.trim()} />
          <Hint>{"Once per check-in, within 24 hours of the verdict. The referee's decision is final."}</Hint>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: 12 },
  title: { fontFamily: fonts.serif, fontSize: 28, color: colors.accent, textAlign: 'center' },
  text: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 21, color: colors.textSecondary, textAlign: 'center' },
});
