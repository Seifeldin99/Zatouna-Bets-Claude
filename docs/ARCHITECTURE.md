# Zatouna: Architecture (MVP)

**Status:** draft for owner review · **Goes with:** [PRODUCT.md](PRODUCT.md)

## The big picture

```
 Phone app (Expo)  ──►  Supabase
   screens,              ├─ Auth          sign-up and log-in
   camera,               ├─ Database      Postgres: all records and the token ledger
   notifications         ├─ Storage       private bucket for check-in photos
                         ├─ Edge Functions small server programs: joining, settling, AI check
                         └─ Cron          a timer that runs jobs: settle, reminders
                                   │
                                   └──►  AI vision model (called only from the server)
```

- **Expo** builds one app for Android and iPhone from the same code.
- **Supabase** is our backend, the part that runs on servers rather than on the phone. **Postgres** is the database inside it.
- **Edge Functions** are small pieces of code that run on Supabase's servers. Anything that moves tokens or uses a secret key runs there, never on the phone, because a phone app can be tampered with.
- **Migrations** are files in the repository that describe every database change. The database is never edited by hand.

## Data model

A **table** is like a spreadsheet tab; each row is one record.

| Table | One row is… | Key fields |
|---|---|---|
| `profiles` | a user | name, time zone, reminder time, **role** (member / support / admin) |
| `challenges` | a challenge | creator, title, rule, schedule, start date, length, stake, misses allowed, **app fee %** (copied in at creation), **status** |
| `challenge_members` | one person in one challenge | challenge, user, joined at, **time zone** (fixed at joining), **result** (in progress / finished / forfeited) |
| `invites` | an invite code | challenge, code, expires at |
| `app_settings` | one row of switches, server only | welcome tokens for new accounts |
| `check_ins` | one photo and note (a retry is a new row) | member, the day it counts for, attempt number, photo path, note, **state** (pending / accepted / rejected) |
| `ai_checks` | the AI's verdict on a check-in | check-in, label, one-line reason, model name, time taken |
| `referee_cases` | a request for support to overrule the AI | check-in, who asked, explanation, support's decision, reason, decided by |
| `push_tokens` | a phone's notification address | user, token |
| `ledger_accounts`, `ledger_transactions`, `ledger_entries` | the token ledger | see below |

A challenge's **status** only ever moves forward: *draft → open* (can join) *→ active* (started) *→ refereeing* (every member's last day is over; 48h for open referee cases) *→ settled*. Because each member runs on their own time zone, a challenge ends only when the member furthest west has finished their last day.

## The token ledger

**Double-entry** is how banks keep books: tokens are never created or deleted silently, they always move *from* one account *to* another. Each move is a **transaction** made of **entries** that add up to exactly zero (−50 here, +50 there).

**Accounts:**
- one **wallet** per user;
- one **pool** per challenge;
- two system accounts: **admin gifts** (where tokens handed out in testing come from) and **app revenue** (where the app fee, rounding leftovers, and pools nobody won go).

Later, a **purchases** account will sit next to *admin gifts* as the source of bought tokens. Nothing else changes.

**Examples:**

| Event | Entries |
|---|---|
| Admin gives Ana 500 | admin gifts −500 · Ana's wallet +500 |
| Ana joins with a stake of 100 | Ana's wallet −100 · pool +100 |
| 4 join at 100; 3 finish | pool −400 · app revenue +10 · each finisher +130 |
| 4 join at 100; 2 finish (fee 20, then 180 ÷ 2) | pool −400 · app revenue +20 · each finisher +190 |
| 5 join at 50; 2 finish (fee 15, then 135 ÷ 2 = 67, 1 left over) | pool −250 · app revenue +16 · each finisher +117 |
| 3 join at 50; nobody finishes | pool −150 · app revenue +150 |

**Settlement maths:** forfeited = stake × members who didn't finish. Fee = forfeited × fee %, rounded down. Each finisher gets their stake plus (forfeited − fee) ÷ finishers, rounded down. Whatever is left in the pool goes to app revenue.

A balance is never stored as a single number someone could overwrite. It is always the **sum of that account's entries**, so the history and the balance can't disagree.

**Rules that keep it correct**, each enforced by the database itself, not just by app code:

1. **Append-only.** Entries are never edited or deleted. A mistake is fixed with a new, reversing transaction.
2. **Balanced.** A transaction is rejected unless its entries sum to zero.
3. **No overdraft.** A user wallet can never go below zero.
4. **Only the server writes.** The phone can read its own history but has no permission to add entries.
5. **One key per real-world event (no duplicate settlement).** Every transaction carries a unique **idempotency key**: a label for the event it records, such as `stake:<challenge>:<user>` or `settle:<challenge>`. The database refuses a second transaction with the same key. "Idempotent" means doing it twice has the same effect as doing it once. So if settlement is retried after a crash or runs twice by accident, the second run changes nothing.
6. **One settlement at a time.** Settlement locks the challenge row, checks that its status is *refereeing*, closes any referee case still open as accepted (PRODUCT.md 7.3), writes all payouts, and sets the status to *settled*, all in **one database transaction**: either every step happens or none does. A second run finds *settled* and stops.
7. **The pool must end at zero.** After settlement the pool's balance is checked to be exactly 0; if not, the whole thing is undone and flagged.

Step 5 of the plan builds this first, with automated tests, including "settling twice pays nothing extra" and "two people joining at the same moment can't overdraw a wallet."

## Where AI checking runs

1. The app uploads the photo to private Storage and creates the check-in row as *pending*.
2. That new row triggers the **`ai-check` Edge Function** on the server.
3. The function sends the photo, the note and the challenge's rule to a vision AI model and asks for one of three labels with a one-line reason.
4. It saves the result in `ai_checks`. *Likely okay* sets the check-in to *accepted*. *Likely not okay* and *unsure* set it to *rejected*. The AI label is still stored, so we can see how often it was unsure.
5. If the model errors or takes longer than 30 seconds, the result counts as *unsure*. The AI's API key lives only on the server.
6. On a rejected check-in, the member can **retry** (a new check-in row, as many as they like before their midnight) or open a **referee case** (within 24 hours). Support's decision overwrites the state and is recorded with who decided and why.

Each retry is a new AI check, which costs a little and gives a cheater another try at fooling the AI. The attempt number is stored, so support can see it on a referee case, and after testing we'll check whether a daily limit is needed.

The model's name is saved with every verdict so we can compare models later (plan step 7: a labelled test set of 50 to 100 photos). Which model and provider to use is decided in that step.

## Permissions

Supabase uses **Row Level Security (RLS)**: rules stored in the database that decide, row by row, who can read or change what. They apply even if someone bypasses the app.

| Data | Who can read | Who can change |
|---|---|---|
| Your profile | you, and members of your challenges (name only) | you |
| A challenge | its members, and anyone holding a valid invite (details only) | its creator, before it opens |
| Check-ins and photos | the author always; other members only once it's accepted, or once that day is over and missed | the author creates; nobody edits after |
| Referee cases | the check-in's author, and support | the author opens one; support decides |
| Token gifts | the receiver, and the admin | the admin only (through a server function) |
| Ledger | you see your own wallet and your challenges' pools | server functions only |

Photos are fetched through **signed URLs**: links that work for a short time only, so a forwarded link stops working. **Support** can see a challenge's check-ins only when a referee case is open on it. The **admin** (you) can do everything support can, plus give tokens. Every support and admin action is logged.

## Out of scope for the MVP

- Real money: buying tokens, cash-out, payments, identity checks. The ledger leaves room for it (see *purchases* above), but nothing is built before legal sign-off.
- Members giving tokens to each other.
- Public challenges, discovery, leaderboards, chat or comments.
- Video, gallery uploads, or anything other than one photo and a note.
- Sign-in with Google, Apple or phone number; web or desktop apps.
- App store release. Android test builds come first, iPhone later (plan step 8).
- Analytics beyond basic error reports; multiple languages.

## Decided

- **AI spending:** capped at about $10 a month during testing.
- **Photo retention:** photos are deleted 90 days after a challenge ends.
- **Support:** only the owner handles referee cases during testing.
- **Account deletion:** a deleted user's token history stays, labelled "deleted user", so everyone else's totals still add up.
- **Server region:** chosen in plan step 4, when the Supabase project is created. The default is US East, the closest to the first markets (US and Canada). Canada (Central) is the alternative if Canadian data has to stay in Canada. A project can't be moved later; moving means creating a new project and copying the data, which is cheap while there are only testers. Real-money rules may set where data must live, so the lawyer should confirm this.

## Open questions for you
None right now.
