# Zatouna: Architecture (MVP)

**Status:** draft for owner review · **Goes with:** [PRODUCT.md](PRODUCT.md)

## The big picture

```
 Phone app (Expo)  ──►  Supabase
   screens,              ├─ Auth          sign-up and log-in
   camera,               ├─ Database      Postgres: all records and the points ledger
   notifications         ├─ Storage       private bucket for check-in photos
                         ├─ Edge Functions small server programs: joining, settling, AI pre-check
                         └─ Cron          a timer that runs jobs: settle, reminders
                                   │
                                   └──►  AI vision model (called only from the server)
```

- **Expo** builds one app for Android and iPhone from the same code.
- **Supabase** is our backend, the part that runs on servers rather than on the phone. **Postgres** is the database inside it.
- **Edge Functions** are small pieces of code that run on Supabase's servers. Anything that moves points or uses a secret key runs there, never on the phone, because a phone app can be tampered with.
- **Migrations** are files in the repository that describe every database change. The database is never edited by hand.

## Data model

A **table** is like a spreadsheet tab; each row is one record.

| Table | One row is… | Key fields |
|---|---|---|
| `profiles` | a user | name, time zone, reminder time |
| `challenges` | a challenge | creator, title, rule, schedule, start and end, stake, misses allowed, time zone, **status** |
| `challenge_members` | one person in one challenge | challenge, user, joined at, **result** (in progress / finished / forfeited) |
| `invites` | an invite code | challenge, code, expires at |
| `check_ins` | one photo and note | member, the day it counts for, photo path, note, **state** (pending / accepted / rejected) |
| `ai_checks` | the AI's verdict on a check-in | check-in, label, one-line reason, model name, time taken |
| `reviews` | a member's approve, reject or flag | check-in, reviewer, decision, reason |
| `appeals` | an appeal | check-in, explanation, admin decision |
| `push_tokens` | a phone's notification address | user, token |
| `ledger_accounts`, `ledger_transactions`, `ledger_entries` | the points ledger | see below |

A challenge's **status** only ever moves forward: *draft → open* (can join) *→ active* (started) *→ reviewing* (ended, 48h for reviews and appeals) *→ settled*.

## The points ledger

**Double-entry** is how banks keep books: points are never created or deleted silently, they always move *from* one account *to* another. Each move is a **transaction** made of **entries** that add up to exactly zero (−50 here, +50 there).

**Accounts:**
- one **wallet** per user;
- one **pool** per challenge;
- two system accounts: **grants** (where the 1,000 starting points come from) and **removed** (where unclaimed points go, e.g. if nobody finishes).

**Examples:**

| Event | Entries |
|---|---|
| Sign-up | grants −1,000 · Ana's wallet +1,000 |
| Ana joins with a stake of 50 | Ana's wallet −50 · pool +50 |
| 3 join at 50; Ana and Ben finish, Cy forfeits | pool −150 · Ana +75 · Ben +75 |
| 4 join at 50; 3 finish (200 ÷ 3 isn't whole) | pool −200 · each finisher +66 · removed +2 |
| 3 join at 50; nobody finishes | pool −150 · removed +150 |

A balance is never stored as a single number someone could overwrite. It is always the **sum of that account's entries**, so the history and the balance can't disagree.

**Rules that keep it correct**, each enforced by the database itself, not just by app code:

1. **Append-only.** Entries are never edited or deleted. A mistake is fixed with a new, reversing transaction.
2. **Balanced.** A transaction is rejected unless its entries sum to zero.
3. **No overdraft.** A user wallet can never go below zero.
4. **Only the server writes.** The phone can read its own history but has no permission to add entries.
5. **One key per real-world event (no duplicate settlement).** Every transaction carries a unique **idempotency key**: a label for the event it records, such as `stake:<challenge>:<user>` or `settle:<challenge>`. The database refuses a second transaction with the same key. "Idempotent" means doing it twice has the same effect as doing it once. So if settlement is retried after a crash or runs twice by accident, the second run changes nothing.
6. **One settlement at a time.** Settlement locks the challenge row, checks that its status is *reviewing*, writes all payouts, and sets the status to *settled*, all in **one database transaction**: either every step happens or none does. A second run finds *settled* and stops.
7. **The pool must end at zero.** After settlement the pool's balance is checked to be exactly 0; if not, the whole thing is undone and flagged.

Step 5 of the plan builds this first, with automated tests, including "settling twice pays nothing extra" and "two people joining at the same moment can't overdraw a wallet."

## Where AI checking runs

1. The app uploads the photo to private Storage and creates the check-in row as *pending*.
2. That new row triggers the **`precheck` Edge Function** on the server.
3. The function sends the photo, the note and the challenge's rule to a vision AI model and asks for one of three labels with a one-line reason.
4. It saves the result in `ai_checks`. *Likely okay* makes the check-in *accepted*; the other two leave it *pending* for friends to review.
5. If the model errors or takes longer than 30 seconds, the label is *unsure*. The AI's API key lives only on the server.

The model's name is saved with every verdict so we can compare models later (plan step 7: a labelled test set of 50 to 100 photos). Which model and provider to use is decided in that step.

## Permissions

Supabase uses **Row Level Security (RLS)**: rules stored in the database that decide, row by row, who can read or change what. They apply even if someone bypasses the app.

| Data | Who can read | Who can change |
|---|---|---|
| Your profile | you, and members of your challenges (name only) | you |
| A challenge | its members, and anyone holding a valid invite (details only) | its creator, before it opens |
| Check-ins and photos | members of that challenge | the author creates; nobody edits after |
| Reviews | members of that challenge | any member except the check-in's author |
| Appeals | the author and the admin | the author creates; the admin decides |
| Ledger | you see your own wallet and your challenges' pools | server functions only |

Photos are fetched through **signed URLs**: links that work for a short time only, so a forwarded link stops working. An **admin** role (you, during testing) can see appeals and decide them.

## Out of scope for the MVP

- Real money, payments, cash-out, buying points, or giving points to others.
- Public challenges, discovery, leaderboards, chat or comments.
- Video, gallery uploads, or anything other than one photo and a note.
- The AI deciding anything on its own.
- Sign-in with Google, Apple or phone number; web or desktop apps.
- App store release. Android test builds come first, iPhone later (plan step 8).
- Analytics beyond basic error reports; multiple languages.

## Open questions for you

1. **AI cost:** each check-in costs a fraction of a cent to check. Is a small monthly cap (for example $10) fine during testing?
2. **Photo retention:** keep photos for 90 days after a challenge ends, then delete them? Shorter is better for privacy.
3. **Admin:** only you, or should a second tester also be an admin?
4. **Supabase region:** I'll pick the one closest to you and your testers. Where are most of them?
5. **Account deletion:** when someone deletes their account, keep their ledger history under "deleted user" so other people's totals still add up? This is my recommendation.
