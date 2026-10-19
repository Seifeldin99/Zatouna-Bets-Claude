# Zatouna: Product Spec (MVP)

**Status:** draft for owner review · **Stack:** Expo (React Native) + Supabase · **Audience:** internal testers only

Zatouna lets you "bet on yourself": join a private challenge with friends, stake tokens, and post a photo and note each time you do the habit. Finishers share the stakes of those who didn't finish, after a fee to the app.

## Ground rules for the MVP

- **Tokens are free during testing.** Only the admin (the owner) hands them out. Testers can't buy them, cash them out or send them to each other.
- **The AI decides each check-in.** If a member disagrees, they can call the **referee**, and customer support makes the final call.
- **The app earns a fee on lost stakes.** In testing, the fee is counted in tokens so we can check the maths.
- **Private only.** Every challenge is invite-only. Dark, minimal look.

## Words used in this document

| Word | Meaning |
|---|---|
| **Token** | The unit you stake. Free in testing; meant to be bought with real money later (see "Later: real money"). |
| **Challenge** | A habit with a rule, a schedule and an end date, e.g. "Read 20 minutes, every day, for 14 days." |
| **Member** | Someone who joined a challenge. The person who made it is the **creator**. |
| **Stake** | The tokens each member puts in when joining. The same amount for everyone in one challenge. |
| **Pool** | Where all stakes in a challenge are held until it ends. |
| **Check-in** | One proof that you did the habit: a photo plus a short note. |
| **AI check** | The AI's verdict on a check-in: *likely okay*, *unsure* or *likely not okay*. |
| **Referee** | A request for customer support to overrule the AI. Support's decision is final. |
| **App fee** | The app's share of the forfeited stakes. |
| **Settlement** | The one-time step at the end that decides who finished and moves the tokens. |
| **Forfeit** | Losing your stake, by missing too many check-ins or quitting. |

## User stories

*Done when* says what must be true for a story to count as built.

### 1. Account and tokens
- **1.1** As a new user, I want to sign up with email. *Done when:* I can sign up, log in and log out.
- **1.2** As the admin, I want to give any tester any number of tokens, with a note. *Done when:* the tokens appear in their balance at once and the gift shows in their history. During testing, every new account starts with **1,000 welcome tokens** (a server setting the admin can turn off); after testing, new users start at 0.
- **1.3** As a user, I want my balance and a history of every token change. *Done when:* each line shows date, amount and reason (e.g. "Stake: Read 20 min").

### 2. Private challenges
- **2.1** As a creator, I want to pick one of the seven challenge templates (Read a Book, Workout, Sunshine, Journaling, Eating Fruits, Learn French, Pet Cat), which sets the title and the rule ("what counts"), then set how often (daily, or N times a week), a start date (today or later), a length (1 to 30 days), a stake, and how many misses are allowed. *Done when:* it's saved as **not started** (or **active** at once if it starts today) and only I can see it. Custom titles and rules are not in the first draft: every challenge comes from a template.
- **2.2** As a creator, I want to edit or delete my challenge during its first day. *Done when:* from the second day, nothing about it can change. Deleting gives everyone their stake back.

### 3. Friends for each challenge
- **3.1** As a creator, I want to invite friends with a link or a short code. *Done when:* the link opens the challenge in the app, and a challenge holds at most **10 members**.
- **3.2** As a member, I want to see who's in and who's on track. *Done when:* friends see my check-in only once it's **accepted**, or once my day is over and **missed**. My rejected attempts, retries and referee cases stay private while my day is still open. Nobody outside the challenge can see anything about it.
- **3.3** Invitees can join until the **end of the first day** (11:59pm on the start date, in the creator's time zone). A challenge starts at midnight on its start date, by itself.

### 4. Staking and forfeiting
- **4.1** As an invitee, I want to join by staking tokens. *Done when:* the stake moves from my balance to the pool at once, and I can't join without enough tokens.
- **4.2** As a member, I want to leave during the first day and get my stake back.
- **4.3** Quitting from the second day on, or missing more than the allowed check-ins, forfeits my stake. *Done when:* the app warns before I quit and shows "misses left."

### 5. Photo-plus-note check-ins
- **5.1** As a member, I want to take a photo in the app and add a note (up to 280 characters) as proof. *Done when:* the photo comes from the camera only, never the gallery, so old photos can't be reused.
- **5.2** Each member's day runs on **their own time zone**, so the habit fits their routine. Your time zone is fixed when you join, so changing your phone's clock can't buy extra hours. A check-in after midnight your time doesn't count for that day.

### 6. AI check
- **6.1** As a member, I want each check-in judged within about a minute, with a one-line reason. *Likely okay* means **accepted**. *Likely not okay* and *unsure* both mean **rejected**, and so does an AI that fails or is too slow.
- **6.2** As a member whose check-in was rejected, I want two buttons: **Retry** (take a new photo and note) and **Referee**. *Done when:* both appear on every rejected check-in. I can retry **as many times as I like** until my midnight. The day counts as soon as one check-in is accepted.

### 7. Referee (customer support)
- **7.1** As a member whose check-in was rejected, I want to call the referee on **my own** check-in with a short explanation. *Done when:* the request reaches the support queue with the photo, note, rule and AI reason. I can do this once per check-in, within 24 hours of the verdict, even after my midnight has passed. While the case is open, the day shows as **waiting for referee**, not as missed.
- **7.2** As support (the admin, during testing), I want a queue of referee cases where I can accept or reject each one with a reason. *Done when:* the member sees the result and the reason, and the decision is final.
- **7.3** Every case is decided before settlement. Anything support hasn't decided by **48 hours after the challenge ends** counts as accepted. The app profits when stakes are lost, so ties go to the member.

### 8. The pool and the app fee
- **8.1** When a challenge ends, the app takes **10% of the forfeited stakes**. Finishers split the rest equally, and each also gets their own stake back. If everyone finishes, there's no fee and everyone gets their stake back.
- **8.2** If nobody finishes, the whole pool goes to the app.
- **8.3** Only whole tokens are paid out. Rounding leftovers go to the app.
- **8.4** As a member, I want a results screen showing who finished, who forfeited, the app fee, and what I received.
- **8.5** Settlement happens **exactly once** per challenge, even if the app or server retries.

*Example:* 4 members stake 100 each, and 3 finish. Forfeited: 100. App fee: 10. Each finisher gets 100 + 30 = 130.

### 9. Reminders
- **9.1** As a member, I want a notification at a time I choose on days I still owe a check-in, plus a "last chance" one two hours before my midnight. *Done when:* none is sent once I've checked in, and I can turn them off per challenge.

## Later: real money (not in the MVP)
The goal is that testers will eventually buy tokens with real money, and the free admin gifts will stop. The data design leaves room for purchases and the app fee, so the code won't need rewriting. **This must not be built before a lawyer signs off.** A stake that can be lost, plus a house cut of the losses, is the textbook shape of gambling. Apple only allows real-money gaming from licensed operators, in the places they're licensed. Apple also says purchased credits may not expire, which conflicts with losing bought tokens. Google Play has similar rules. The first markets are the **US and Canada**. Both regulate this by state or province, so the lawyer has to check each one.

## Also not in the MVP
Buying, cashing out or transferring tokens, custom challenges and rules (only the seven templates for now), public challenges, leaderboards, chat, video or gallery uploads, non-email logins, and web or desktop versions.

## Open questions for you
None right now. Your answers so far are written into the stories above. We'll revisit stake size, retries and the grace period after testing.
