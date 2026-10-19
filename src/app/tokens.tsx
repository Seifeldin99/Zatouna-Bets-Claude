import { RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Card, EmptyState, ErrorText, Hint, Loading, Screen, ScreenHeader, TokenAmount } from '@/components/ui';
import { type TokenLine, myBalance, myTokenHistory, tokenLineLabel } from '@/lib/challenges';
import { goBack } from '@/lib/navigation';
import { useLoad } from '@/lib/use-load';
import { colors, fonts } from '@/theme';

async function loadTokens() {
  const [balance, lines] = await Promise.all([myBalance(), myTokenHistory()]);
  return { balance, lines };
}

/** Your balance and every change to it (product story 1.3). The balance is the sum of the lines. */
export default function TokensScreen() {
  const { data, error, loading, refreshing, reload } = useLoad(loadTokens);

  return (
    <Screen
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={reload}
          tintColor={colors.accent}
          colors={[colors.accent]}
          progressBackgroundColor={colors.surface}
        />
      }>
      <ScreenHeader title="Your tokens" onBack={() => goBack('/(tabs)')} />
      {error && <ErrorText>{error}</ErrorText>}
      {loading && <Loading />}
      {data && (
        <>
          <Card style={styles.balance}>
            <Text style={styles.balanceLabel}>Balance</Text>
            <TokenAmount amount={data.balance} size={34} />
          </Card>
          {data.lines.length === 0 ? (
            <EmptyState title="Nothing yet" body="Stakes, payouts and gifts show up here as they happen." />
          ) : (
            <Card style={styles.list}>
              {data.lines.map((line) => (
                <Line key={line.id} line={line} />
              ))}
            </Card>
          )}
          <Hint>Your balance is always the sum of these lines. Test tokens have no cash value.</Hint>
        </>
      )}
    </Screen>
  );
}

function Line({ line }: { line: TokenLine }) {
  const positive = line.amount > 0;
  return (
    <View style={styles.line}>
      <View style={styles.lineText}>
        <Text style={styles.lineLabel}>{tokenLineLabel(line)}</Text>
        <Text style={styles.lineDate}>{formatWhen(line.at)}</Text>
      </View>
      <Text style={[styles.amount, positive ? styles.amountUp : styles.amountDown]}>
        {positive ? '+' : '−'}
        {Math.abs(line.amount)}
      </Text>
    </View>
  );
}

/** "Oct 20, 3:14 PM" in the phone's time zone. */
function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const styles = StyleSheet.create({
  balance: { alignItems: 'center', gap: 8 },
  balanceLabel: {
    fontFamily: fonts.sansBold,
    fontSize: 11,
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: colors.textSecondary,
  },
  list: { gap: 16 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  lineText: { flex: 1, gap: 2 },
  lineLabel: { fontFamily: fonts.sansMedium, fontSize: 15, color: colors.text },
  lineDate: { fontFamily: fonts.sans, fontSize: 13, color: colors.textSecondary },
  amount: { fontFamily: fonts.sansBold, fontSize: 17 },
  amountUp: { color: colors.accent },
  amountDown: { color: colors.danger },
});
