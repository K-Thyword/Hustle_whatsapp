// Answers "what's my score/rank on the Hustle @1 leaderboard?" — the one
// promo question the static FAQ text in promoInfo.ts can never cover on its
// own, since that's fixed copy with no notion of who's actually asking.
//
// Reads the SAME `leaderboard_grand` view the live promos.hustleapp.io
// public page already uses (see supabase.ts's header for the project this
// points at) — this never recalculates points itself, so it can't drift
// from what a customer would see if they opened that page directly. That
// view already filters to `status = 'approved'` point_events only, which
// matches the webapp's own promise on promo.html ("no self-reported
// numbers shown here, only points a real person has confirmed") — so a
// pending, not-yet-reviewed submission correctly doesn't show up as points
// yet here either.

import { getSupabase } from "./supabase";
import { getCurrentPromoId, findEntrantByPhone } from "./promoEntry";

export type PromoStandingResult =
  | { status: "ranked"; username: string; points: number; rank: number; totalEntrants: number }
  | { status: "pending_review" }
  | { status: "not_entered" }
  | { status: "unavailable" };

interface GrandRow {
  entrant_id: string;
  leaderboard_username: string;
  total_points: number;
}

export async function getPromoStanding(whatsappPhone: string): Promise<PromoStandingResult> {
  const supabase = getSupabase();
  if (!supabase) return { status: "unavailable" };

  const promoId = await getCurrentPromoId();
  if (!promoId) return { status: "unavailable" };

  // Look the entrant up directly first (regardless of whether they've got
  // any approved points yet) so "never entered" and "entered, still under
  // review" get two different, honest replies instead of both just looking
  // like silence from the leaderboard query below.
  const entrant = await findEntrantByPhone(whatsappPhone, promoId);
  if (!entrant) return { status: "not_entered" };

  const { data, error } = await supabase
    .from("leaderboard_grand")
    .select("entrant_id, leaderboard_username, total_points")
    .eq("promo_id", promoId)
    .order("total_points", { ascending: false });

  if (error || !data) {
    console.error("[Promo leaderboard] Failed to load leaderboard_grand:", error);
    return { status: "unavailable" };
  }

  const rows = data as GrandRow[];
  const index = rows.findIndex((r) => r.entrant_id === entrant.id);
  if (index === -1) {
    // Entrant record exists but isn't on the board yet — either their only
    // submission is still awaiting admin review, or (same underlying
    // cause) their entrant status hasn't been flipped to 'active' yet,
    // which admin.html's approveSubmission does together with the first
    // approval.
    return { status: "pending_review" };
  }

  const row = rows[index];
  return {
    status: "ranked",
    username: row.leaderboard_username,
    points: row.total_points,
    rank: index + 1,
    totalEntrants: rows.length,
  };
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function buildPromoStandingReply(result: PromoStandingResult, promoIsLive: boolean): string {
  if (result.status === "ranked") {
    const pts = `${result.points} point${result.points === 1 ? "" : "s"}`;
    const closing = promoIsLive
      ? "Keep going — more approved entries mean more points!"
      : "That's your final standing — thanks for taking part!";
    return `You're ${ordinal(result.rank)} out of ${result.totalEntrants} on the Hustle @1 leaderboard, with ${pts} as "${result.username}". ${closing}`;
  }
  if (result.status === "pending_review") {
    return "You're entered, but your latest submission is still waiting on review — your points will show up here as soon as it's approved.";
  }
  if (result.status === "not_entered") {
    return "I don't see an entry for you yet in the Hustle @1 promo — send a screenshot of one of the qualifying actions (signing up, following us, etc.) to get on the board!";
  }
  return "I can't check the leaderboard right now — try again in a bit, or say 'agent' if it's urgent.";
}

// Deliberately loose: "point"/"score"/"rank"/"leaderboard"/"standing"/
// "position" essentially never come up in this business's normal
// booking-related chat (nobody asks a marketplace bot for a plumber's
// "score"), so requiring BOTH a scoring keyword and a first-person
// reference anywhere in the message — not necessarily adjacent, since real
// phrasing varies a lot ("where do I see my scores?", "what is my points
// now?", "have I got any points yet") — keeps this from misfiring on
// ordinary booking chat while still catching the natural ways people
// actually ask this.
const PROMO_SCORE_KEYWORDS = /\b(points?|scores?|ranks?|rankings?|leaderboards?|standings?|positions?)\b/i;
const FIRST_PERSON_RE = /\b(my|i'?m|i've|am i|do i|have i|did i|i have|i got)\b/i;

export function isAskingAboutOwnPromoStanding(text: string): boolean {
  return PROMO_SCORE_KEYWORDS.test(text) && FIRST_PERSON_RE.test(text);
}
