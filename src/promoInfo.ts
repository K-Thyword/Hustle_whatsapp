// The "Hustle @1" anniversary promo (Sep 1 – Nov 30, 2026) — unlike
// everything in businessInfo.ts, this is genuinely time-bound content, so
// it can't just be a static string appended forever. getPromoSection()
// only returns the promo details while the promo is actually live; once
// PROMO_END passes it returns an empty string automatically, so the bot
// stops mentioning/offering it with no follow-up code change needed on
// Nov 30 — nothing else has to remember to come back and remove this.
//
// Full official rules: http://promos.hustleapp.io/promo/hustle-at-1
// (the bot's summary below is a conversational digest, not the legal
// text — always point someone to that page for the actual rules).

const PROMO_START = new Date("2026-09-01T00:00:00Z");
const PROMO_END = new Date("2026-11-30T23:59:59Z");

const PROMO_DETAILS = `
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

export function getPromoSection(now: Date = new Date()): string {
  if (now < PROMO_START || now > PROMO_END) return "";
  return `\n${PROMO_DETAILS}\n`;
}
