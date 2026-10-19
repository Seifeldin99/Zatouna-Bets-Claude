import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button, Card, Hint, Screen, SectionLabel, Title } from '@/components/ui';
import { displayNameOf, useAuth } from '@/lib/auth';
import { amSupport, refereeQueue } from '@/lib/referee';
import { supabase } from '@/lib/supabase';
import { useLoad } from '@/lib/use-load';
import { colors, fonts } from '@/theme';

/** Support (the admin during testing) also sees how many referee cases wait. */
async function loadSupport() {
  const support = await amSupport();
  const waiting = support ? (await refereeQueue()).filter((c) => c.decision === 'open').length : 0;
  return { support, waiting };
}

export default function SettingsScreen() {
  const { session } = useAuth();
  const { data: support } = useLoad(loadSupport);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signOut() {
    setSigningOut(true);
    setError(null);
    const { error: signOutError } = await supabase.auth.signOut();
    // On success the auth listener sends the user back to the sign-in screen.
    if (signOutError) {
      setError(signOutError.message);
      setSigningOut(false);
    }
  }

  return (
    <Screen>
      <Title>Settings</Title>

      <View style={styles.section}>
        <SectionLabel>Account</SectionLabel>
        <Card style={styles.account}>
          <Text style={styles.name}>{displayNameOf(session)}</Text>
          <Text style={styles.email}>{session?.user.email}</Text>
        </Card>
      </View>

      {support?.support && (
        <View style={styles.section}>
          <SectionLabel>Referee</SectionLabel>
          <Button
            label={support.waiting > 0 ? `Referee queue (${support.waiting} waiting)` : 'Referee queue'}
            variant="secondary"
            onPress={() => router.push('/referee')}
          />
          <Hint>Members who think the AI got it wrong send their check-in here. You decide, with a reason.</Hint>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}
      <Button label="Sign out" variant="outline" onPress={signOut} loading={signingOut} />

      <Text style={styles.version}>Version {Constants.expoConfig?.version}</Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  account: { gap: 4 },
  name: { fontFamily: fonts.sansSemiBold, fontSize: 17, color: colors.text },
  email: { fontFamily: fonts.sans, fontSize: 14, color: colors.textSecondary },
  error: { fontFamily: fonts.sansMedium, fontSize: 14, color: colors.danger },
  version: {
    fontFamily: fonts.sans,
    fontSize: 12,
    color: colors.textMuted,
    textAlign: 'center',
  },
});
