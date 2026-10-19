import { SymbolView, type SymbolViewProps } from 'expo-symbols';
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
  type ScrollViewProps,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, fonts, gutter, radius } from '@/theme';

type ScreenProps = {
  children: ReactNode;
  refreshControl?: ScrollViewProps['refreshControl'];
  keyboardShouldPersistTaps?: ScrollViewProps['keyboardShouldPersistTaps'];
};

export function Screen({ children, refreshControl, keyboardShouldPersistTaps }: ScreenProps) {
  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.screenContent}
        refreshControl={refreshControl}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}>
        {children}
      </ScrollView>
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

export function ErrorText({ children }: { children: ReactNode }) {
  return <Text style={styles.error}>{children}</Text>;
}

export function Notice({ children }: { children: ReactNode }) {
  return <Text style={styles.notice}>{children}</Text>;
}

/** Small grey explanation under a field or a section. */
export function Hint({ children }: { children: ReactNode }) {
  return <Text style={styles.hint}>{children}</Text>;
}

export function Loading() {
  return <ActivityIndicator color={colors.accent} style={styles.loading} />;
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  /** primary: green. secondary: dark. outline: red text, for destructive actions. */
  variant?: 'primary' | 'secondary' | 'outline';
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
        variant === 'secondary' && styles.buttonSecondary,
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

export type Icon = SymbolViewProps['name'];

/** Round icon button: the green "+" on Challenges, a back arrow, a close cross. */
export function IconButton({
  icon,
  label,
  onPress,
  tone = 'surface',
}: {
  icon: Icon;
  label: string;
  onPress: () => void;
  tone?: 'surface' | 'primary';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [
        styles.iconButton,
        tone === 'primary' && styles.iconButtonPrimary,
        pressed && styles.buttonPressed,
      ]}>
      <SymbolView name={icon} tintColor={colors.text} size={22} />
    </Pressable>
  );
}

/** Top row of a screen outside the tabs: back (or close), a title, an optional control. */
export function ScreenHeader({
  title,
  onBack,
  back = 'back',
  right,
}: {
  title?: string;
  onBack: () => void;
  back?: 'back' | 'close';
  right?: ReactNode;
}) {
  const icon: Icon =
    back === 'close'
      ? { ios: 'xmark', android: 'close' }
      : { ios: 'chevron.left', android: 'arrow_back' };
  return (
    <View style={styles.header}>
      <IconButton icon={icon} label={back === 'close' ? 'Close' : 'Back'} onPress={onBack} />
      <Text style={styles.headerTitle} numberOfLines={1}>
        {title ?? ''}
      </Text>
      <View style={styles.headerRight}>{right}</View>
    </View>
  );
}

export function TextField({ label, hint, ...inputProps }: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.textMuted}
        selectionColor={colors.accent}
        style={[styles.input, inputProps.multiline && styles.inputMultiline]}
        {...inputProps}
      />
      {hint ? <Hint>{hint}</Hint> : null}
    </View>
  );
}

/** A value changed with round "−" and "+" buttons, like the Days stepper in the design. */
export function Stepper({
  label,
  display,
  value,
  min,
  max,
  onChange,
  hint,
}: {
  label: string;
  display: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  hint?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.stepper}>
        <StepButton sign="−" label={`Less ${label}`} disabled={value <= min} onPress={() => onChange(value - 1)} />
        <Text style={styles.stepperValue}>{display}</Text>
        <StepButton sign="+" label={`More ${label}`} disabled={value >= max} onPress={() => onChange(value + 1)} />
      </View>
      {hint ? <Hint>{hint}</Hint> : null}
    </View>
  );
}

function StepButton({
  sign,
  label,
  disabled,
  onPress,
}: {
  sign: string;
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.stepButton, disabled && styles.buttonInactive, pressed && styles.buttonPressed]}>
      <Text style={styles.stepSign}>{sign}</Text>
    </Pressable>
  );
}

/** A selectable pill, used for the template picker. */
export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.buttonPressed]}>
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

/** Small status pill, e.g. "ACTIVE". */
export function Pill({ label, tone = 'green' }: { label: string; tone?: 'green' | 'muted' | 'red' }) {
  return (
    <View style={[styles.pill, tone === 'green' && styles.pillGreen, tone === 'red' && styles.pillRed]}>
      <Text
        style={[
          styles.pillLabel,
          tone === 'green' && styles.pillLabelGreen,
          tone === 'red' && styles.pillLabelRed,
        ]}>
        {label}
      </Text>
    </View>
  );
}

/** A number with the token coin next to it. */
export function TokenAmount({ amount, size = 15 }: { amount: number; size?: number }) {
  return (
    <View style={styles.tokenAmount} accessibilityLabel={`${amount} tokens`}>
      <Image source={require('../../assets/images/token.png')} style={{ width: size + 3, height: size + 3 }} />
      <Text style={[styles.tokenText, { fontSize: size }]}>{amount}</Text>
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

/** One tile of the 2×2 stat grid on the challenge page. */
export function StatTile({
  label,
  value,
  tokens,
  tone = 'normal',
}: {
  label: string;
  value: string | number;
  tokens?: boolean;
  tone?: 'normal' | 'red';
}) {
  return (
    <View style={styles.statTile}>
      <Text style={[styles.statTileLabel, tone === 'red' && styles.statTileLabelRed]}>{label}</Text>
      {tokens && typeof value === 'number' ? (
        <TokenAmount amount={value} size={22} />
      ) : (
        <Text style={styles.statTileValue}>{value}</Text>
      )}
    </View>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <View style={styles.statGrid}>{children}</View>;
}

/** A row in a label/value list, e.g. "Start date   Tue, Oct 20". */
export function InfoRow({ label, value, tone = 'normal' }: { label: string; value: string; tone?: 'normal' | 'green' }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, tone === 'green' && styles.infoValueGreen]}>{value}</Text>
    </View>
  );
}

/** The dark box with green small-caps labels (GOAL / RECOMMENDATION / ...). */
export function InfoBox({ sections }: { sections: { label: string; text: string }[] }) {
  return (
    <View style={styles.infoBox}>
      {sections.map((s) => (
        <View key={s.label} style={styles.infoBoxSection}>
          <Text style={styles.infoBoxLabel}>{s.label}</Text>
          <Text style={styles.infoBoxText}>{s.text}</Text>
        </View>
      ))}
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
  error: { fontFamily: fonts.sansMedium, fontSize: 14, color: colors.danger },
  notice: { fontFamily: fonts.sansMedium, fontSize: 14, color: colors.accent },
  hint: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, color: colors.textMuted, paddingHorizontal: 4 },
  loading: { marginVertical: 24 },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radius.control,
    paddingVertical: 18,
    alignItems: 'center',
  },
  buttonSecondary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
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
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerTitle: { flex: 1, fontFamily: fonts.serif, fontSize: 22, color: colors.text, textAlign: 'center' },
  headerRight: { width: 44, alignItems: 'flex-end' },
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
  inputMultiline: { minHeight: 96, textAlignVertical: 'top' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 4 },
  stepButton: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepSign: { fontFamily: fonts.sansBold, fontSize: 20, lineHeight: 24, color: colors.text },
  stepperValue: { flex: 1, fontFamily: fonts.sansSemiBold, fontSize: 17, color: colors.text },
  chip: {
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipLabel: { fontFamily: fonts.sansMedium, fontSize: 14, color: colors.textSecondary },
  chipLabelSelected: { color: colors.text },
  pill: {
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: colors.border,
    alignSelf: 'flex-start',
  },
  pillGreen: { backgroundColor: 'rgba(5,150,105,0.2)' },
  pillRed: { backgroundColor: 'rgba(248,113,113,0.15)' },
  pillLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: colors.textSecondary,
  },
  pillLabelGreen: { color: colors.accent },
  pillLabelRed: { color: colors.danger },
  tokenAmount: { flexDirection: 'row', alignItems: 'center', gap: 6 },
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
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  statTile: {
    width: '47%',
    flexGrow: 1,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.tile,
    padding: 16,
    gap: 8,
  },
  statTileLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: colors.textSecondary,
  },
  statTileLabelRed: { color: colors.danger },
  statTileValue: { fontFamily: fonts.serif, fontSize: 24, color: colors.text },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  infoLabel: { fontFamily: fonts.sans, fontSize: 14, color: colors.textSecondary },
  infoValue: { fontFamily: fonts.sansSemiBold, fontSize: 14, color: colors.text, flexShrink: 1, textAlign: 'right' },
  infoValueGreen: { color: colors.accent },
  infoBox: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.tile,
    padding: 18,
    gap: 14,
  },
  infoBoxSection: { gap: 4 },
  infoBoxLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 10,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: colors.accent,
  },
  infoBoxText: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 21, color: colors.text },
});
