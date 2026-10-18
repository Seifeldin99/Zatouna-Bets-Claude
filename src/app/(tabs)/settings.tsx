import Constants from 'expo-constants';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button, Card, Screen, SectionLabel, Title } from '@/components/ui';
import { displayNameOf, useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { colors, fonts } from '@/theme';

export default function SettingsScreen() {
  const { session } = useAuth();
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
