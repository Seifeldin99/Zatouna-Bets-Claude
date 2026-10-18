import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, fonts, gutter, radius } from '@/theme';

export function Screen({ children }: { children: ReactNode }) {
  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView contentContainerStyle={styles.screenContent}>{children}</ScrollView>
    </SafeAreaView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return <Text style={styles.title}>{children}</Text>;
}

/** Tiny bold uppercase label, e.g. "NEXT UP". */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <Card>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </Card>
  );
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'outline';
};

export function Button({ label, onPress, loading, disabled, variant = 'primary' }: ButtonProps) {
  const inactive = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={inactive}
      style={({ pressed }) => [
        styles.button,
        variant === 'outline' && styles.buttonOutline,
        inactive && styles.buttonInactive,
        pressed && styles.buttonPressed,
      ]}>
      {loading ? (
        <ActivityIndicator color={colors.text} />
      ) : (
        <Text style={[styles.buttonLabel, variant === 'outline' && styles.buttonLabelOutline]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function TextField({ label, ...inputProps }: TextInputProps & { label: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.accent}
        style={styles.input}
        {...inputProps}
      />
    </View>
  );
}

export function TokenBadge({ balance }: { balance: number }) {
  return (
    <View style={styles.tokenBadge} accessibilityLabel={`${balance} tokens`}>
      <Image source={require('../../assets/images/token.png')} style={styles.tokenIcon} />
      <Text style={styles.tokenText}>{balance}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  screenContent: { padding: gutter, paddingBottom: 40, gap: 24 },
  title: { fontFamily: fonts.serif, fontSize: 32, color: colors.text },
  sectionLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: colors.textSecondary,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.card,
    padding: 22,
  },
  emptyTitle: { fontFamily: fonts.sansSemiBold, fontSize: 16, color: colors.text },
  emptyBody: { fontFamily: fonts.sans, fontSize: 14, color: colors.textSecondary, marginTop: 6 },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radius.control,
    paddingVertical: 18,
    alignItems: 'center',
  },
  buttonOutline: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonInactive: { opacity: 0.5 },
  buttonPressed: { transform: [{ scale: 0.97 }] },
  buttonLabel: { fontFamily: fonts.sansBold, fontSize: 16, color: colors.text },
  buttonLabelOutline: { color: colors.danger },
  field: { gap: 8 },
  fieldLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: colors.textMuted,
    paddingHorizontal: 4,
  },
  input: {
    fontFamily: fonts.sansMedium,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 2,
    borderRadius: radius.control,
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  tokenBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  tokenIcon: { width: 18, height: 18 },
  tokenText: { fontFamily: fonts.sansBold, fontSize: 15, color: colors.accent },
});
