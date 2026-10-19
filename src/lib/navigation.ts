import { router, type Href } from 'expo-router';

/** Goes back, or to a sensible screen when the app was opened straight on this one (a link). */
export function goBack(fallback: Href = '/(tabs)/bets') {
  if (router.canGoBack()) router.back();
  else router.replace(fallback);
}
