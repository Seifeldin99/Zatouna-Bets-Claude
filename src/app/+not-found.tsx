import { Link } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { colors, fonts } from '@/theme';

export default function NotFoundScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>This screen doesn&apos;t exist.</Text>
      <Link href="/" style={styles.link}>
        Go to the home screen
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    backgroundColor: colors.background,
  },
  title: { fontFamily: fonts.serif, fontSize: 22, color: colors.text },
  link: { marginTop: 16, fontFamily: fonts.sansBold, fontSize: 15, color: colors.accent },
});
