// Visual tokens from docs/design/DESIGN.md (taken from the Gemini build's stylesheet).

export const colors = {
  background: '#000000',
  surface: '#171717',
  border: '#262626',
  primary: '#047857',
  accent: '#059669',
  text: '#FFFFFF',
  textSecondary: '#A3A3A3',
  textMuted: '#737373',
  danger: '#F87171',
  onPrimaryMuted: 'rgba(255,255,255,0.6)',
  onPrimaryTile: 'rgba(255,255,255,0.1)',
} as const;

export const fonts = {
  serif: 'PlayfairDisplay_400Regular',
  serifBold: 'PlayfairDisplay_700Bold',
  sans: 'Inter_400Regular',
  sansMedium: 'Inter_500Medium',
  sansSemiBold: 'Inter_600SemiBold',
  sansBold: 'Inter_700Bold',
} as const;

export const radius = {
  panel: 32,
  card: 28,
  control: 20,
  tile: 20,
  pill: 999,
} as const;

export const gutter = 20;
