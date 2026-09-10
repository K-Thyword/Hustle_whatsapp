// The "Hustle @1" anniversary promo (Sep 1 – Nov 30, 2026) — unlike
// everything in businessInfo.ts, this is genuinely time-bound content, so
// it can't just be a static string appended forever. getPromoSection()
// switches between three phases (upcoming / live / expired) based on the
// clock, so the bot NEVER loses the ability to talk about the promo — it
// just tells the truth about its status. Before Sep 1 it says the promo
// hasn't started; during the window it gives full entry/points details;
// after Nov 30 it says the promo has ended and entries are closed. No
// follow-up code change is needed when the window opens or closes —
// nothing else has to remember to come back and update this.
//
// Full official rules: http://promos.hustleapp.io/promo/hustle-at-1
// (the bot's summary below is a conversational digest, not the legal
// text — always point someone to that page for the actual rules).

const PROMO_START = new Date("2026-09-01T00:00:00Z");
const PROMO_END = new Date("2026-11-30T23:59:59Z");

const PROMO_LIVE = `
Current promotion — "Hustle @1" (HustleApp's 1-year anniversary promo):
- Live now through November 30, 2026. Free to enter. Earn points, win weekly
  and grand prizes.
- WHO IT'S FOR: registered, active Hustlers (service providers) only, who
  are legal adults resident in Ghana. Customers do NOT earn points and
  can't enter — but completing a booking with a Hustler still gives that
  Hustler bonus points, so a customer booking as usual indirectly helps
  whichever provider they hire.
- HOW TO ENTER (an extra step beyond just signing up):
  1. Sign up and complete your Hustler profile in the app (Android or
     iPhone — see "How to sign up as a Hustler" above), if not done already.
  2. Send a screenshot of your completed profile to 055 693 7198 on
     WhatsApp (one of the official customer care numbers — not this bot).
  3. Already signed up before the promo started? Same step — send the
     screenshot to opt in.
  4. A team member reviews the screenshot and confirms entry; points land
     once that's done.
- HOW POINTS ARE EARNED (examples, not exhaustive — see full rules link
  below): signing up (+10), completing your profile (+15), receiving a
  completed and paid booking (+20, uncapped), following HustleApp's
  Instagram/Facebook/TikTok/X/YouTube (+5 each), posting original content
  tagged #HustleAppTurns1 (+15/week), sharing the anniversary post (+10),
  liking/commenting on HustleApp social posts (+2/+3).
- HOW WINNERS ARE DECIDED: no random drawing — highest points simply wins.
  13 weekly pools (one per week, Sep 1 – Nov 30) plus one cumulative grand
  pool decided at the end (Nov 30, 2026).
- PRIZES: both weekly and grand prizes are still to be announced — if
  asked what they are, say they haven't been announced yet, don't guess.
- Full official rules and current leaderboard standings:
  http://promos.hustleapp.io/promo/hustle-at-1
`.trim();

const PROMO_UPCOMING = `
Upcoming promotion — "Hustle @1" (HustleApp's 1-year anniversary promo):
- Hasn't started yet. It's scheduled to run September 1 – November 30,
  2026, for registered Hustlers (service providers) — free to enter, earn
  points, win weekly and grand prizes.
- It is NOT open for entries yet. If someone asks to enter or sign up for
  it now, tell them it hasn't launched yet rather than walking them
  through entry steps — don't invent an early-entry process.
- Full official rules (and confirmation of the exact launch date) will be
  at http://promos.hustleapp.io/promo/hustle-at-1 — point them there, or
  say "agent" connects them with a human for anything more specific.
`.trim();

const PROMO_EXPIRED = `
Past promotion — "Hustle @1" (HustleApp's 1-year anniversary promo):
- This ran September 1 – November 30, 2026 and has now ENDED. It is CLOSED
  — no new entries, no more points, nothing left to opt into.
- If someone asks how to enter, sign up, or earn points for it now, tell
  them plainly that the promo already ran and has wrapped up — don't walk
  them through the old entry steps as if they still apply.
- Don't guess whether winners/prizes have been announced or what they
  were unless told otherwise here — point them to
  http://promos.hustleapp.io/promo/hustle-at-1 or say "agent" for a human
  to check.
- If they ask about a new/future promo, say you don't have details on one
  yet and offer "agent" for a human — don't imply this one is still
  running or invent a new one.
`.trim();

export type PromoPhase = "upcoming" | "live" | "expired";

// Shared with the entry-submission pipeline (see promoEntry.ts) so it only
// ever attempts to classify/log a screenshot as a promo entry while the
// promo is actually live — same clock, same boundaries, one source of
// truth instead of two places independently comparing dates.
export function getPromoPhase(now: Date = new Date()): PromoPhase {
  if (now < PROMO_START) return "upcoming";
  if (now > PROMO_END) return "expired";
  return "live";
}

export function getPromoSection(now: Date = new Date()): string {
  const phase = getPromoPhase(now);
  if (phase === "upcoming") return `\n${PROMO_UPCOMING}\n`;
  if (phase === "expired") return `\n${PROMO_EXPIRED}\n`;
  return `\n${PROMO_LIVE}\n`;
}
