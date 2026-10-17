# Zatouna: Product Spec (MVP)

**Status:** draft for owner review · **Stack:** Expo (React Native) + Supabase · **Audience:** internal testers only

Zatouna lets you "bet on yourself": join a private challenge with friends, stake free points, and post a photo and note each time you do the habit. Finishers share the stakes of those who didn't finish.

## Ground rules for the MVP

- **Points are free and worth nothing outside the app.** No buying, cashing out or sending them to others. This keeps Zatouna clear of gambling and in-app-purchase rules; real money waits for legal advice.
- **The AI sorts, people decide.** The AI never rejects a check-in on its own.
- **Private only.** Every challenge is invite-only. Dark, minimal look.

## Words used in this document

| Word | Meaning |
|---|---|
| **Challenge** | A habit with a rule, a schedule and an end date, e.g. "Read 20 minutes, every day, for 14 days." |
| **Member** | Someone who joined a challenge. The person who made it is the **creator**. |
| **Stake** | The points each member puts in when joining. The same amount for everyone in one challenge. |
| **Pool** | Where all stakes in a challenge are held until it ends. |
| **Check-in** | One proof that you did the habit: a photo plus a short note. |
| **Pre-check** | The AI's first look at a check-in: *likely okay*, *unsure*, or *likely not okay*. |
| **Settlement** | The one-time step at the end that decides who finished and moves the points. |
| **Forfeit** | Losing your stake, by missing too many check-ins or quitting. |

## User stories

*Done when* says what must be true for a story to count as built.

### 1. Account and points
- **1.1** As a new user, I want to sign up with email so that I have an account. *Done when:* I can sign up, log in and log out.
- **1.2** As a new user, I want a starting balance of free points so that I can join my first challenge. *Done when:* I receive **1,000 points** once, at sign-up.
- **1.3** As a user, I want my balance and a history of every points change. *Done when:* each line shows date, amount and reason (e.g. "Stake: Read 20 min").

### 2. Private challenges
- **2.1** As a creator, I want to set a title, the rule ("what counts"), how often (daily, or N times a week), a start date, a length (7 to 30 days), a stake, and how many misses are allowed. *Done when:* it's saved as **not started** and only I can see it.
- **2.2** As a creator, I want to edit or delete my challenge before it starts. *Done when:* once it starts, nothing about it can change.

### 3. Friends for each challenge
- **3.1** As a creator, I want to invite friends with a link or a short code so that only people I choose can join. *Done when:* the link opens the challenge's details in the app, and a challenge holds at most **10 members**.
- **3.2** As a member, I want to see who's in, their check-ins, and who's on track. *Done when:* nobody outside the challenge can see anything about it.
- **3.3** As an invitee, I can only join **before** the start date.

### 4. Staking and forfeiting
- **4.1** As an invitee, I want to join by staking points so that I have something to lose. *Done when:* the stake moves from my balance to the pool at once, and I can't join without enough points.
- **4.2** As a member, I want to leave before the start and get my stake back.
- **4.3** Quitting after the start, or missing more than the allowed check-ins, forfeits my stake. *Done when:* the app warns before I quit and shows "misses left."

### 5. Photo-plus-note check-ins
- **5.1** As a member, I want to take a photo in the app and add a note (up to 280 characters) as proof. *Done when:* the photo comes from the camera, not the gallery (so old photos can't be reused), and my friends see it.
- **5.2** One check-in counts per scheduled day. A check-in after that day's deadline (midnight in the challenge's time zone) does not count.

### 6. AI pre-check
- **6.1** As a member, I want each check-in labelled *likely okay*, *unsure* or *likely not okay* with a one-line reason, so obvious cases are quick and doubtful ones get a human look. *Done when:* the label appears within about a minute; if the AI fails or is slow, it's *unsure*.
- **6.2** *Likely okay* counts right away, but friends can still flag it until the challenge ends.
- **6.3** *Unsure* and *likely not okay* go to human review. They count as **pending** in the meantime, not as missed.

### 7. Human review and appeals
- **7.1** As a member, I want to approve or reject friends' pending or flagged check-ins, giving a reason for rejections. *Done when:* one other member's vote decides, and nobody reviews their own.
- **7.2** As a member whose check-in was rejected, I want to appeal **once** with a short explanation. *Done when:* the appeal goes to the app admin (during testing, the owner), whose decision is final.
- **7.3** Reviews and appeals close **48 hours after the challenge ends**. Anything undecided then counts as accepted, so nobody loses points to a slow reviewer.

### 8. The shared pool
- **8.1** As a finisher, I want the pool split equally among finishers: my stake back plus an equal share of forfeited stakes. Whole points only; rounding leftovers are removed from play.
- **8.2** If nobody finishes, all stakes are removed from play. Nobody gains.
- **8.3** As a member, I want a results screen showing who finished, who forfeited, and what I received.
- **8.4** Settlement happens **exactly once** per challenge, even if the app or server retries.

### 9. Reminders
- **9.1** As a member, I want a notification at a time I choose on days I still owe a check-in, plus a "last chance" one two hours before the deadline. *Done when:* none is sent once I've checked in, and I can turn them off per challenge.

## Not in the MVP
Real money, buying or transferring points, public challenges, leaderboards, chat, video or gallery uploads, non-email logins, and web or desktop versions. See ARCHITECTURE.md for the technical side.

## Open questions for you
Each has the default I wrote above. Tell me which ones to change.

1. **Starting points:** a one-time 1,000. Should active users also get a top-up, e.g. 100 a week, so nobody gets stuck at zero?
2. **Stake size:** the creator picks any amount from 10 to 500. Should it be fixed instead?
3. **Who reviews:** any other member, and one vote decides. Should it take a majority instead?
4. **Final appeals:** go to you as admin. Fine for testing, but who should decide once more people use it?
5. **Nobody finishes:** the stakes are removed. Would you rather everyone got their stake back?
6. **Rounding leftovers:** removed. Or should they go to the finisher with the most check-ins?
7. **Time zone:** the creator's time zone sets every member's daily deadline. Is that okay for friends abroad?
8. **Camera only:** blocks gallery photos. Too strict for habits like "cook a meal," where you might snap a photo first?
9. **Late check-ins:** none allowed. Should there be a grace period of an hour or two?
