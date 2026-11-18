import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, StyleSheet, Text, View } from 'react-native';

import { Button, Card, Hint, Notice, Screen, SectionLabel, Stepper, Title } from '@/components/ui';
import { displayNameOf, useAuth } from '@/lib/auth';
import { amSupport, refereeQueue } from '@/lib/referee';
import { EARLIEST_MINUTES, LATEST_MINUTES, formatMinutes } from '@/lib/reminder-plan';
import {
  askForNotifications,
  loadReminderSettings,
  notificationAccess,
  refreshReminders,
  setReminderTime,
} from '@/lib/reminders';
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

      {session && <Reminders userId={session.user.id} />}

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

/** Half-hour steps for the reminder time. */
const STEP_MINUTES = 30;

/** The daily reminder's time, and a way to turn notifications on when the phone has them off. */
function Reminders({ userId }: { userId: string }) {
  const load = useCallback(
    async () => ({ settings: await loadReminderSettings(userId), access: await notificationAccess() }),
    [userId],
  );
  const { data, reload } = useLoad(load);
  const [minutes, setMinutes] = useState<number | null>(null);
  const [asking, setAsking] = useState(false);

  // Coming back from the phone's settings may have changed the permission.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void reload();
    });
    return () => subscription.remove();
  }, [reload]);

  if (!data) return null;
  const shown = minutes ?? data.settings.minutes;
  const step = (shown - EARLIEST_MINUTES) / STEP_MINUTES;

  function change(nextStep: number) {
    const next = EARLIEST_MINUTES + nextStep * STEP_MINUTES;
    setMinutes(next);
    void setReminderTime(userId, next);
  }

  async function turnOn() {
    setAsking(true);
    await askForNotifications();
    await refreshReminders(userId);
    await reload();
    setAsking(false);
  }

  return (
    <View style={styles.section}>
      <SectionLabel>Reminders</SectionLabel>
      <Stepper
        label="Daily reminder"
        display={formatMinutes(shown)}
        value={step}
        min={0}
        max={(LATEST_MINUTES - EARLIEST_MINUTES) / STEP_MINUTES}
        onChange={change}
        hint="On days you still owe a check-in, you get this reminder plus a last-chance one 2 hours before midnight. To switch them off for one challenge, open it and use its Reminders switch."
      />
      {data.access === 'not_asked' && <Button label="Turn on reminders" onPress={turnOn} loading={asking} />}
      {data.access === 'blocked' && (
        <>
          <Notice>{"Notifications are off for Zatouna in your phone's settings, so reminders can't show."}</Notice>
          <Button label="Open phone settings" variant="secondary" onPress={() => Linking.openSettings()} />
        </>
      )}
    </View>
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
