import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ColorValue } from 'react-native';
import { Tabs } from 'expo-router/js-tabs';

import { colors, fonts } from '@/theme';

function TabIcon({ name, color }: { name: SymbolViewProps['name']; color: ColorValue }) {
  return <SymbolView name={name} tintColor={color} size={24} />;
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: { backgroundColor: colors.background, borderTopColor: colors.surface },
        tabBarLabelStyle: {
          fontFamily: fonts.sansBold,
          fontSize: 10,
          letterSpacing: 1,
          textTransform: 'uppercase',
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color }) => (
            <TabIcon name={{ ios: 'square.grid.2x2', android: 'grid_view' }} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="bets"
        options={{
          title: 'Bets',
          tabBarIcon: ({ color }) => (
            <TabIcon name={{ ios: 'trophy', android: 'trophy' }} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => (
            <TabIcon name={{ ios: 'gearshape', android: 'settings' }} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
