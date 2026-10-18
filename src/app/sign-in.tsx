import { useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, TextField } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { colors, fonts, gutter } from '@/theme';

type Mode = 'sign-in' | 'sign-up';

const MIN_PASSWORD_LENGTH = 6;
const MAX_NAME_LENGTH = 40;

export default function SignInScreen() {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const isSignUp = mode === 'sign-up';

  function switchMode() {
    setMode(isSignUp ? 'sign-in' : 'sign-up');
    setError(null);
    setNotice(null);
  }

  function validate(): string | null {
    if (isSignUp && !name.trim()) return 'Please enter your name.';
    if (!email.trim()) return 'Please enter your email.';
    if (password.length < MIN_PASSWORD_LENGTH) {
      return `Your password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    return null;
  }

  async function submit() {
    const problem = validate();
    setError(problem);
    setNotice(null);
    if (problem) return;

    setBusy(true);
    if (isSignUp) {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { data: { display_name: name.trim() } },
      });
      if (signUpError) {
        setError(signUpError.message);
      } else if (!data.session) {
        // Only happens if email confirmation is switched on in Supabase.
        setNotice('Check your inbox to confirm your email, then sign in.');
        setMode('sign-in');
      }
    } else {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) setError(signInError.message);
    }
    // On success the auth listener swaps this screen for the tabs.
    setBusy(false);
  }

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Image
              source={require('../../assets/images/icon.png')}
              style={styles.logo}
              accessibilityIgnoresInvertColors
            />
            <Text style={styles.wordmark}>Zatouna</Text>
            <Text style={styles.tagline}>Bet on yourself.</Text>
          </View>

          <Text style={styles.heading}>{isSignUp ? 'Create your account' : 'Welcome back'}</Text>

          <View style={styles.form}>
            {isSignUp && (
              <TextField
                label="Name"
                value={name}
                onChangeText={setName}
                placeholder="What friends call you"
                autoComplete="name"
                maxLength={MAX_NAME_LENGTH}
              />
            )}
            <TextField
              label="Email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
            />
            <TextField
              label="Password"
              value={password}
              onChangeText={setPassword}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              autoCapitalize="none"
              autoComplete={isSignUp ? 'new-password' : 'current-password'}
              secureTextEntry
            />

            {error && <Text style={styles.error}>{error}</Text>}
            {notice && <Text style={styles.notice}>{notice}</Text>}

            <Button
              label={isSignUp ? 'Sign up' : 'Sign in'}
              onPress={submit}
              loading={busy}
            />
          </View>

          <Pressable onPress={switchMode} style={styles.switch} accessibilityRole="button">
            <Text style={styles.switchText}>
              {isSignUp ? 'Already have an account? ' : 'New to Zatouna? '}
              <Text style={styles.switchLink}>{isSignUp ? 'Sign in' : 'Create an account'}</Text>
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: gutter, paddingTop: 48, gap: 28, flexGrow: 1 },
  brand: { alignItems: 'center', gap: 8 },
  logo: { width: 88, height: 88, borderRadius: 24 },
  wordmark: { fontFamily: fonts.serif, fontSize: 36, color: colors.text, marginTop: 8 },
  tagline: { fontFamily: fonts.sans, fontSize: 15, color: colors.textSecondary },
  heading: { fontFamily: fonts.serif, fontSize: 26, color: colors.text },
  form: { gap: 18 },
  error: { fontFamily: fonts.sansMedium, fontSize: 14, color: colors.danger },
  notice: { fontFamily: fonts.sansMedium, fontSize: 14, color: colors.accent },
  switch: { alignItems: 'center', paddingVertical: 8 },
  switchText: { fontFamily: fonts.sans, fontSize: 14, color: colors.textSecondary },
  switchLink: { fontFamily: fonts.sansBold, color: colors.accent },
});
