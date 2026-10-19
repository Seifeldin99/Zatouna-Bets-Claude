# Zatouna

Bet on yourself. A mobile habit app with challenges, free points you stake on finishing, photo check-ins, and friends who keep you honest.

- What the app does: [docs/PRODUCT.md](docs/PRODUCT.md)
- How the data and rules work: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- How it looks: [docs/design/DESIGN.md](docs/design/DESIGN.md), with screenshots and the preset challenges in [docs/design/challenge-templates.md](docs/design/challenge-templates.md)
- Rules for Claude when changing the code: [CLAUDE.md](CLAUDE.md)

Stack: Expo (React Native) + Supabase. Internal testing only.

## Running it (for developers)

1. `npm install`
2. Copy `.env.example` to `.env` and fill in the Supabase project URL and publishable key.
3. `npm start`, then open the app on a phone with a development build.

Checks: `npm run check`. Database tests: `npm run test:db` (needs PostgreSQL installed). Android test build: `npx eas-cli@latest build --profile preview --platform android`.
