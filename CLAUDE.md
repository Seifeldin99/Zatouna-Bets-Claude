# Zatouna: rules for Claude

Zatouna is a habit app where friends stake tokens on finishing challenges. Expo (React Native) app + Supabase backend. Internal testing only.

@AGENTS.md

## Read before changing anything
- `docs/PRODUCT.md`: what the app does. It is the source of truth for behaviour.
- `docs/ARCHITECTURE.md`: data model, token ledger, permissions.
- `docs/design/DESIGN.md`: the look. Theme values live in `src/theme.ts`; use them instead of new colours or fonts.
- Where the old Gemini app (pictured in `docs/design/`) and the spec disagree, the spec wins.

## Working with the owner
- The owner does not code. Every pull request says, in plain words, what changed and what to tap on the phone to test it.
- Ask the owner whenever a product decision is not 100% clear. Don't guess.
- One feature per pull request. Nothing reaches `main` without the owner's merge.

## Tokens and money (never break these)
- Never pay out twice. Every ledger transaction has a unique idempotency key, and settlement runs once per challenge (ARCHITECTURE.md, "Rules that keep it correct").
- Balances are the sum of ledger entries, never a stored number.
- Only server code (Edge Functions or database functions) moves tokens. The app never writes ledger rows.
- Any change to ledger or settlement code comes with automated tests, including "settling twice pays nothing extra".

## Backend and secrets
- Database changes go through migration files in `supabase/migrations/`. Never edit the database by hand in the dashboard.
- `EXPO_PUBLIC_*` variables are compiled into the app and readable by anyone: only the Supabase URL and publishable key go there. Service-role keys and AI keys live only in Supabase function secrets.
- Never commit `.env` files, tokens or passwords.
- Builds read `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` from the EAS `preview` environment.

## Before opening a pull request
- `npm run check` (typecheck and lint) passes.
- `npm run test:db` (database and ledger tests) passes. It needs a local PostgreSQL; it refuses to run as root, so in a root container run it as the `postgres` user.
- For app changes, the Android bundle builds: `npx expo export --platform android` with the two `EXPO_PUBLIC_*` variables set.
- Android test build: `npx eas-cli@latest build --profile preview --platform android` produces an install link (APK, internal distribution).

## Layout
- `src/app/`: screens (Expo Router). `(tabs)/` holds Home, Bets and Settings; `sign-in.tsx` is shown when signed out.
- `src/lib/`: Supabase client and auth state.
- `src/components/ui.tsx`: shared building blocks (Screen, Card, Button, TextField, TokenBadge).
- `supabase/migrations/`: database changes. `supabase/tests/`: database tests (Node test runner against a throwaway local Postgres with a small Supabase stand-in).
