import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import {
  PlayfairDisplay_400Regular,
  PlayfairDisplay_700Bold,
} from '@expo-google-fonts/playfair-display';
import * as Notifications from 'expo-notifications';
import { useFonts } from 'expo-font';
import { DarkTheme, Stack, ThemeProvider, router, type Href, type Theme } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { AppState } from 'react-native';

import { AuthProvider, useAuth } from '@/lib/auth';
import { clearReminders, refreshReminders } from '@/lib/reminders';
import { colors } from '@/theme';

export {
  // Show expo-router's error screen instead of a blank app if anything throws.
  ErrorBoundary,
} from 'expo-router';

SplashScreen.preventAutoHideAsync();

// Reminders that arrive while the app is open still show as a banner.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const navigationTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.accent,
    background: colors.background,
    card: colors.background,
    text: colors.text,
    border: colors.border,
  },
};

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    PlayfairDisplay_400Regular,
    PlayfairDisplay_700Bold,
  });

  useEffect(() => {
    if (fontError) throw fontError;
  }, [fontError]);

  if (!fontsLoaded) return null;

  return (
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  );
}

function RootNavigator() {
  const { session, loading } = useAuth();
  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (!loading) SplashScreen.hideAsync();
  }, [loading]);

  useReminders(loading, userId);
  useReminderTaps(!loading && userId !== null);

  if (loading) return null;

  return (
    <ThemeProvider value={navigationTheme}>
      <StatusBar style="light" />
      <Stack
        screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
        <Stack.Protected guard={!!session}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="challenge/new" options={{ presentation: 'modal' }} />
          <Stack.Screen name="challenge/[id]/index" />
          <Stack.Screen name="challenge/[id]/edit" options={{ presentation: 'modal' }} />
          <Stack.Screen name="challenge/[id]/check-in" options={{ presentation: 'modal' }} />
          <Stack.Screen name="challenge/[id]/referee" options={{ presentation: 'modal' }} />
          <Stack.Screen name="referee/index" />
          <Stack.Screen name="referee/[id]" />
          <Stack.Screen name="join/[code]" />
          <Stack.Screen name="tokens" />
        </Stack.Protected>
        <Stack.Protected guard={!session}>
          <Stack.Screen name="sign-in" />
        </Stack.Protected>
      </Stack>
    </ThemeProvider>
  );
}

/** Keeps the reminders current: on sign-in, whenever the app comes back to the front, and cleared on sign-out. */
function useReminders(loading: boolean, userId: string | null) {
  useEffect(() => {
    if (loading) return;
    if (!userId) {
      void clearReminders().catch(() => {});
      return;
    }
    void refreshReminders(userId);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshReminders(userId);
    });
    return () => subscription.remove();
  }, [loading, userId]);
}

/** Tapping a reminder opens its challenge. */
function useReminderTaps(signedIn: boolean) {
  const response = Notifications.useLastNotificationResponse();

  useEffect(() => {
    if (!signedIn || !response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const url = response.notification.request.content.data?.url;
    // Forget the tap once handled, so the next app start doesn't open it again.
    void Notifications.clearLastNotificationResponseAsync().catch(() => {});
    if (typeof url === 'string' && url.startsWith('/challenge/')) router.push(url as Href);
  }, [signedIn, response]);
}
