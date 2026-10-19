# Zatouna visual design reference

Source: the owner's Gemini (AI Studio) build, 2026-10-18. Screenshots in this folder: `home.png`, `challenges.png`, `new-bet.png`, `new-bet-goal-picker.png`, `challenge-detail-won.png`, `challenge-detail-lost.png`, `token-history.png`. Logos: `zatouna-logo.jpg`, `zatouna-cat-logo.jpg`, `zatouna-token.jpg`. Preset challenges and their AI instructions: [challenge-templates.md](challenge-templates.md). Values below are taken from that app's stylesheet (`src/index.css`) and screens, and are the target look for the Expo rebuild. The Gemini code itself is not reused.

## Colors
| Role | Value | Where it appears |
|---|---|---|
| Background | `#000000` | Whole app |
| Card surface | `#171717` (neutral-900) with a 1px `#262626` (neutral-800) border | Challenge cards, stat tiles, tab groups |
| Primary green | `#047857` | Welcome panel, Verify button, "+" button, active tab icon |
| Accent green | `#059669` | Highlights, progress fill |
| Text | `#FFFFFF`; secondary `#A3A3A3` (neutral-400); muted `#737373` (neutral-500) | Body, labels |
| Status pill "Active" | dark green pill, green text | Challenge card |
| Danger | red-500 at 10–20% background, red-400 text | Errors, "lost" states |

## Type
- Headings: **Playfair Display** (serif), regular weight, large ("Challenges", "Welcome back, Seifeldin!" with the name in bold).
- Everything else: **Inter**. Section labels are tiny (10–12px), bold, uppercase, wide letter spacing ("NEXT UP", "FRIENDS", "PROGRESS", "VERIFICATION").
- Numbers in stat tiles are large and bold.

## Shape and spacing
- Very rounded corners: cards and buttons use 24–32px radius; small pills use full rounding.
- Generous padding inside cards (about 20–24px). Screen gutter about 16–24px.
- Buttons press with a slight scale-down (active:scale-95).
- Subtle entrance animations (fade/scale) on modals and the loading logo.

## Layout
- **Bottom tab bar** with three tabs: Home, Bets, Settings. Icons above tiny uppercase labels; the active tab is green.
- **Home:** header with cat logo + "Zatouna", a bell (notifications) and a green token badge showing the balance. A large green welcome panel with the date, greeting, and two stat tiles (Active, Won). A "Progress" card with a slim progress bar and "x / y days completed". "Next up" list of today's due challenges. "Friends" row of round cat avatars with a "+" to add.
- **Bets (Challenges):** serif title, green "+" button, a segmented pill group of tabs (Active / Public / Friends / Completed). Each challenge card: title, verification method in small caps, "Progress" bar with "done / total", stake with the token icon, days left with a clock icon, and a green pill **Verify** button with a camera icon.
- **New bet** (`new-bet.png`): serif "New Bet" title with a close button. Goal picker (serif dropdown of the preset challenges), then a dark info box with green small-caps labels GOAL / RECOMMENDATION / ACCEPTANCE. Round "−" / "+" steppers for Days and Bet tokens, start date, visibility, verification method, and a full-width green "Place Bet" button.
- **Challenge detail** (`challenge-detail-*.png`): a rounded dark sheet with serif title and "BY @username" in green small caps. Overview/Chat segmented control. A 2×2 grid of stat tiles (Participants, Friends, Total invested, Tokens lost in red). The same GOAL / RECOMMENDATION / ACCEPTANCE box. A label/value list (start date, duration, visibility, status in green). A full-width **white** "View results" button.
- **Token history** (`token-history.png`): list of dark rounded rows. Each shows the type in bold (Bet, Lost, Won), the challenge name, a red "Lost: N tokens" line where relevant, date and running balance in small grey text, and the amount on the right (red for negative). Note: the screenshot shows each "Lost" entry recorded twice, a symptom of the Gemini app's double-settlement bug, not a design choice.
- **Camera:** full-screen black, rounded viewfinder, big white shutter button, back camera by default.
- Avatars default to cartoon cat faces on a black circle.

## What changes in the rebuild (spec wins over the Gemini app)
- No **Public** tab and no challenge **chat** in the MVP (PRODUCT.md "Also not in the MVP"). Tabs become Active / Completed; friends appear inside a challenge.
- New users start with **0 tokens**; the admin grants them (story 1.2). The Gemini app gave 100 on sign-up.
- Proof photos are never shown to other members; friends see only accepted / missed per day (story 3.2).
- Every rejected check-in shows **Retry** and **Referee** buttons (story 6.2); the Gemini app only had a message.
- Results screen shows who finished, who forfeited, the **10% app fee**, and each payout (story 8.4).
- Challenge creation uses the spec's fields (schedule, length, stake, misses allowed). The Gemini app's preset list (Read a Book, Sunshine, Journaling, Eating Fruits, Learn French, Workout, Pet Cat) is kept as **templates**; every challenge is made from one (no custom titles or rules in the first draft), and the per-preset AI instructions seed the AI check prompts.
