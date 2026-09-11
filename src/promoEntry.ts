// "Hustle @1" promo entry pipeline — writes into the REAL, already-built
// Supabase project ("Hustle DBAnnex", mxaqgkdbyswksacqmyiv) and its
// `entrants`/`submissions`/`point_rules` schema, used by the existing
// promos.hustleapp.io admin webapp (admin.html) and public promo page
// (promo.html). This is a rewrite of an earlier version that invented its
// own parallel schema before that real project was discovered — see
// docs/prd/0001-hustle-at-1-entry-system.md for the correction history.
//
// Division of responsibility, matching the real admin webapp exactly:
// this bot ONLY ever writes to `entrants` (creating one, once, per new
// phone), `submissions` (status: 'pending'/'duplicate'), and its own
// `entrant_social_handles` bookkeeping table. It never touches
// `point_events` — turning an approved submission into actual points is
// exclusively the admin's manual action in admin.html's approveSubmission,
// same as before this bot existed. Nothing here bypasses that review step.
//
// Identity model (per Tee, 2026-09-10): a screenshot's visible name/email
// gets extracted and stored as an ADMIN-VISIBLE HINT (entrants.provider_
// name / .provider_email — never treated as verified), while the actual
// public leaderboard identity is a username the customer chooses for
// themselves, asked once per phone and enforced unique (case-insensitive,
// per promo) at the database level.
//
// Fraud-mitigation pass (per Tee, 2026-09-11) added three more things,
// none of which are treated as automatic rejections — every one of them
// is a signal surfaced to admin for a human judgment call, never a block:
//   1. Perceptual image hashing (imageFingerprint.ts) to flag when a
//      screenshot's near-identical to one already on file, possibly from
//      a different entrant.
//   2. Identity-collision checks: when a newly-learned provider_name/
//      provider_email matches a DIFFERENT entrant's, that's flagged too
//      (possible multi-accounting).
//   3. A vision-classifier tamper/edit flag for obvious signs of editing.
// Plus a first-time social-handle capture: the first time an entrant does
// a given platform's social action, the bot asks what account/profile
// name they used, logs it for admin to cross-check, and auto-reuses it on
// every later submission for that same platform without asking again.
// booking_completed always gets an explicit "needs manual confirmation"
// flag — it's the single highest-value action (20 pts) and the one with
// the clearest financial incentive to fake, and there's no automated way
// to check it against the real booking yet.

import Anthropic from "@anthropic-ai/sdk";
import { downloadWhatsAppMedia } from "./whatsappMedia";
import { getSupabase, PROMO_SCREENSHOT_BUCKET } from "./supabase";
import { computeImageHash, hammingDistance, DUPLICATE_HASH_THRESHOLD } from "./imageFingerprint";

const hasRealKey =
  process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== "from-console.anthropic.com";
const anthropic = hasRealKey ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

// The 13 action_type values from point_rules that a screenshot can actually
// prove. Deliberately excludes two real rows that exist in the same table:
// "opt_in_broadcast" (the bot should award this directly when a customer
// opts into the WhatsApp broadcast list — no screenshot involved) and
// "manual_adjustment" (admin-only, by definition never bot-submitted).
export type PromoActionType =
  | "signup"
  | "complete_profile"
  | "list_services"
  | "follow_instagram"
  | "follow_facebook"
  | "follow_tiktok"
  | "follow_x"
  | "follow_youtube"
  | "like_post"
  | "comment_post"
  | "post_hashtag_content"
  | "share_anniversary"
  | "tag_hustlers_comment"
  | "booking_completed";

const PROMO_ACTION_TYPES: PromoActionType[] = [
  "signup",
  "complete_profile",
  "list_services",
  "follow_instagram",
  "follow_facebook",
  "follow_tiktok",
  "follow_x",
  "follow_youtube",
  "like_post",
  "comment_post",
  "post_hashtag_content",
  "share_anniversary",
  "tag_hustlers_comment",
  "booking_completed",
];

// Same reasoning as before: a false negative just falls back to the normal
// image-description flow (cheap); a false positive pollutes the admin
// queue with a claim that was never really made. ai_raw_response is kept
// on every submission specifically so this can be tuned once real
// submissions show how the classifier actually performs.
const CONFIDENCE_THRESHOLD = 0.55;

interface RawClassification {
  isPromoEntry: boolean;
  actionType: string | null;
  targetRef: string | null;
  confidence: number;
  extractedName: string | null;
  extractedEmail: string | null;
  platform: string | null;
  tamperSuspected: boolean;
  tamperReason: string | null;
  profileVerificationCompleted: boolean;
  screenshotSource: "hustleapp_app" | "social_media" | "unclear";
  description: string;
}

export type SocialPlatform = "instagram" | "facebook" | "tiktok" | "x" | "youtube";
const SOCIAL_PLATFORMS: SocialPlatform[] = ["instagram", "facebook", "tiktok", "x", "youtube"];

const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  x: "X",
  youtube: "YouTube",
};

// Action types tied to a specific social-media account/profile — the ones
// where "which account did you use for this?" is a meaningful question at
// all (unlike signup/complete_profile/booking_completed, which aren't
// about a social platform). Per Tee (2026-09-11): ask for the account name
// once per entrant per platform, log it for admin to cross-check, and
// reuse it automatically on every later action for that same platform.
const SOCIAL_ACTION_TYPES = new Set<PromoActionType>([
  "follow_instagram",
  "follow_facebook",
  "follow_tiktok",
  "follow_x",
  "follow_youtube",
  "like_post",
  "comment_post",
  "post_hashtag_content",
  "share_anniversary",
  "tag_hustlers_comment",
]);

// follow_* actions name their platform outright; the rest (a like/comment/
// hashtag post/share/tag on some unspecified post) need the classifier's
// own best guess from the screenshot's visual style/branding or a visible
// URL. Returns undefined if this action type isn't platform-specific at
// all, or the classifier couldn't tell — handled gracefully by callers
// (the handle step is just skipped, not treated as a failure).
function resolvePlatform(actionType: PromoActionType, classifierPlatform: string | null): SocialPlatform | undefined {
  switch (actionType) {
    case "follow_instagram":
      return "instagram";
    case "follow_facebook":
      return "facebook";
    case "follow_tiktok":
      return "tiktok";
    case "follow_x":
      return "x";
    case "follow_youtube":
      return "youtube";
    default:
      if (!SOCIAL_ACTION_TYPES.has(actionType)) return undefined;
      return classifierPlatform && SOCIAL_PLATFORMS.includes(classifierPlatform as SocialPlatform)
        ? (classifierPlatform as SocialPlatform)
        : undefined;
  }
}

function normalizeMimeType(mimeType: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  const supported = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  return (supported.includes(mimeType) ? mimeType : "image/jpeg") as never;
}

const CLASSIFY_PROMPT = `You're screening WhatsApp screenshots for Hustleapp's "Hustle @1" anniversary promo. Registered Hustlers (service providers) earn points by doing one of these things and sending a screenshot as proof:

- "signup": proof they've created a Hustleapp Hustler account. This includes a welcome/registration-success screen, but MOST COMMONLY it's a screenshot of the app's own Account Settings / provider dashboard screen — things like an "Available to work" toggle, Working Hours, Account verification status, Business Details, etc. Reaching this screen at all is proof the account exists. Do NOT require the profile to be complete or verification to say "Verified" — an account verification status of "Pending" is completely normal and still counts as a valid signup screenshot. A brand-new Hustler's profile isn't expected to be complete yet, so don't hold that against this action type.
- "complete_profile": specifically their Hustleapp profile shown as 100% / fully complete (a distinct, later milestone from signup above) — these typically show their own name AND email alongside an explicit completion indicator. Don't confuse this with the general Account Settings screen described under "signup" — that one counts as signup even when incomplete. (You don't need to separately pick this action type for the Account Settings screen specifically — see profileVerificationCompleted below, which covers that case.)
- "list_services": a screenshot of the Hustler's own "Services" page in the app — the list of services THEY offer as a provider (e.g. service names, categories, or prices they've added to their profile), not a customer browsing other providers' services. Reaching this screen with at least one service listed counts, even if it's not a long list.
- "follow_instagram" / "follow_facebook" / "follow_tiktok" / "follow_x" / "follow_youtube": proof they follow HustleApp's account on that SPECIFIC platform — e.g. "Following" shown on Hustleapp's page, or Hustleapp appearing in their own following list. Pick the exact platform, don't guess if unclear.
- "like_post": proof they liked one of HustleApp's social posts.
- "comment_post": proof they commented on one of HustleApp's social posts. If a post URL/permalink is visible, put it in targetRef.
- "post_hashtag_content": a post THEY made on social media, tagged #HustleAppTurns1.
- "share_anniversary": proof they shared HustleApp's anniversary announcement post, tagged @hustleapp.
- "tag_hustlers_comment": proof they tagged 3 other hustlers in the comments of an anniversary post.
- "booking_completed": a completed AND PAID booking/job on the Hustleapp platform (e.g. a payment confirmation or "job complete" screen).

If the image doesn't clearly match one of these, set isPromoEntry to false and actionType to null — but still fill in screenshotSource honestly (see below), since even an unmatched screenshot might still be from our app or our socials and worth a follow-up question rather than being silently ignored.

Always assess screenshotSource, regardless of isPromoEntry:
- "hustleapp_app": this is a screenshot of the Hustleapp app itself (its UI, branding, or a Hustleapp-specific screen), even if you can't tell which specific action above it proves.
- "social_media": this is a screenshot of Instagram, Facebook, TikTok, X, or YouTube — HustleApp's page/post or otherwise — even if you can't tell which specific action above it proves.
- "unclear": neither of the above plausibly applies — a random photo, an unrelated screenshot, a job-site photo, some other unrelated app, etc.

Also extract, only when actually legible in the image (never guess or infer):
- extractedName: a personal name that plausibly belongs to whoever took this screenshot (e.g. in a profile header, a "Welcome, X" banner, or as a comment/post author).
- extractedEmail: an email address, if visible.
- targetRef: a post URL, permalink, or other reference identifying the SPECIFIC post involved (relevant mainly for comment_post/like_post/share_anniversary) — null if nothing like that is visible.
- platform: which social platform this screenshot is FROM, if it's a social action (like_post/comment_post/post_hashtag_content/share_anniversary/tag_hustlers_comment) — one of "instagram", "facebook", "tiktok", "x", "youtube", based on the visible UI style/branding or a URL shown, or null if you genuinely can't tell. (For the follow_* action types the platform is already implied by the action type itself — you can still fill this in the same way, but it won't be relied on there.)

Also assess, honestly and conservatively:
- tamperSuspected: true only if you see clear, concrete signs of digital editing — mismatched fonts, misaligned/duplicated UI elements, inconsistent lighting or pixel artifacts around text, a screenshot-of-a-screenshot moiré pattern, or a resolution/aspect-ratio that doesn't match the claimed app's real UI. Do NOT set this true just because something is merely hard to read, oddly cropped, or a normal photo of a phone screen (glare, an angled photo, a slightly blurry photo, or a boring crop are all normal, not tampering) — false accusations of editing are worse than missing real ones, since a real person will actually see and read this.
- tamperReason: one short plain sentence explaining why, only if tamperSuspected is true — otherwise null.
- profileVerificationCompleted: ONLY relevant when actionType is "signup" via the Account Settings screen (see above) — set true if the "Account verification information" row on that exact screen visibly reads "Completed" (green, next to a shield icon). Set false if it reads "Pending", anything else, isn't present, or isn't clearly legible — never guess. This one screenshot proves BOTH signup AND profile completion when true, so getting this wrong either awards or withholds real points; when in doubt, false.

Respond with strict JSON only, no markdown formatting, matching exactly:
{"isPromoEntry": boolean, "actionType": string|null, "targetRef": string|null, "confidence": number (0-1), "extractedName": string|null, "extractedEmail": string|null, "platform": string|null, "tamperSuspected": boolean, "tamperReason": string|null, "profileVerificationCompleted": boolean, "screenshotSource": "hustleapp_app"|"social_media"|"unclear", "description": string (always fill this in — 1 short plain-English sentence describing the image, used as a fallback if this isn't treated as a promo entry)}`;

async function classify(buffer: ArrayBuffer, mimeType: string, caption?: string): Promise<RawClassification | undefined> {
  if (!anthropic) return undefined;
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: normalizeMimeType(mimeType),
                data: Buffer.from(buffer).toString("base64"),
              },
            },
            {
              type: "text",
              text: CLASSIFY_PROMPT + (caption ? `\n\nThe sender's own caption on this image was: "${caption}"` : ""),
            },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return undefined;

    const cleaned = textBlock.text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.isPromoEntry !== "boolean" || typeof parsed.description !== "string") return undefined;
    return {
      isPromoEntry: parsed.isPromoEntry,
      actionType: typeof parsed.actionType === "string" ? parsed.actionType : null,
      targetRef: typeof parsed.targetRef === "string" && parsed.targetRef.trim() ? parsed.targetRef.trim() : null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      extractedName: typeof parsed.extractedName === "string" && parsed.extractedName.trim() ? parsed.extractedName.trim() : null,
      extractedEmail:
        typeof parsed.extractedEmail === "string" && parsed.extractedEmail.trim() ? parsed.extractedEmail.trim() : null,
      platform: typeof parsed.platform === "string" && parsed.platform.trim() ? parsed.platform.trim().toLowerCase() : null,
      tamperSuspected: parsed.tamperSuspected === true,
      tamperReason:
        typeof parsed.tamperReason === "string" && parsed.tamperReason.trim() ? parsed.tamperReason.trim() : null,
      profileVerificationCompleted: parsed.profileVerificationCompleted === true,
      screenshotSource:
        parsed.screenshotSource === "hustleapp_app" || parsed.screenshotSource === "social_media"
          ? parsed.screenshotSource
          : "unclear",
      description: parsed.description.trim(),
    };
  } catch (err) {
    console.error("[Promo entry] Vision classification failed:", err);
    return undefined;
  }
}

// Pulled out as a pure function (no network calls) so the accept/reject
// decision can be unit-tested with synthetic classifier output. Returns
// null for anything that should fall back to the normal image-description
// flow: not flagged as an entry, an unrecognized action_type (a model
// hallucination, or drift between this code and point_rules), or below
// CONFIDENCE_THRESHOLD.
export function validateClassification(
  result: Pick<RawClassification, "isPromoEntry" | "actionType" | "confidence">
): { actionType: PromoActionType } | null {
  if (!result.isPromoEntry) return null;
  if (!result.actionType || !PROMO_ACTION_TYPES.includes(result.actionType as PromoActionType)) return null;
  if (result.confidence < CONFIDENCE_THRESHOLD) return null;
  return { actionType: result.actionType as PromoActionType };
}

// Username rules are intentionally light — length sanity only. Nothing
// stops an admin renaming an entrant later (admin.html already supports
// this), so the bot doesn't need to be the last line of defense on content.
export function validateUsername(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 2 || trimmed.length > 24) return null;
  return trimmed;
}

// Same light-touch philosophy as validateUsername — a social handle just
// needs to be a plausible short string; admin can always follow up if
// something looks off when they cross-check it manually. Strips a leading
// "@" since people type handles both ways.
export function validateSocialHandle(raw: string): string | null {
  const trimmed = raw.trim().replace(/^@/, "");
  if (trimmed.length < 1 || trimmed.length > 40) return null;
  return trimmed;
}

interface PromoRow {
  id: string;
}

let cachedPromo: { id: string; cachedAt: number } | null = null;
const PROMO_CACHE_MS = 5 * 60 * 1000;

// Exported for promoLeaderboard.ts — same cached lookup, no reason to
// duplicate it just because the leaderboard-standing feature lives in a
// separate file from entry-logging.
export async function getCurrentPromoId(): Promise<string | undefined> {
  if (cachedPromo && Date.now() - cachedPromo.cachedAt < PROMO_CACHE_MS) return cachedPromo.id;
  const supabase = getSupabase();
  if (!supabase) return undefined;
  const { data, error } = await supabase.from("promos").select("id").eq("is_current", true).maybeSingle();
  if (error || !data) {
    console.error("[Promo entry] Failed to look up current promo:", error);
    return undefined;
  }
  const row = data as PromoRow;
  cachedPromo = { id: row.id, cachedAt: Date.now() };
  return row.id;
}

interface PointRuleRow {
  action_type: string;
  label: string;
  points: number;
  active: boolean;
}

let cachedRules: { map: Map<string, PointRuleRow>; cachedAt: number } | null = null;

async function getPointRule(actionType: PromoActionType, promoId: string): Promise<PointRuleRow | undefined> {
  const supabase = getSupabase();
  if (!supabase) return undefined;
  if (!cachedRules || Date.now() - cachedRules.cachedAt >= PROMO_CACHE_MS) {
    const { data, error } = await supabase.from("point_rules").select("action_type, label, points, active").eq("promo_id", promoId);
    if (error || !data) {
      console.error("[Promo entry] Failed to load point_rules:", error);
      return undefined;
    }
    cachedRules = { map: new Map((data as PointRuleRow[]).map((r) => [r.action_type, r])), cachedAt: Date.now() };
  }
  return cachedRules.map.get(actionType);
}

interface EntrantRow {
  id: string;
  whatsapp_number: string;
  leaderboard_username: string;
  provider_name: string | null;
  provider_email: string | null;
}

// Exported for promoLeaderboard.ts — it needs to distinguish "never
// entered" from "entered but not yet on the leaderboard view" (pending
// review), which means looking the entrant up directly rather than only
// through leaderboard_grand (which only lists entrants with an approved
// point_event at all).
export async function findEntrantByPhone(whatsappPhone: string, promoId: string): Promise<EntrantRow | undefined> {
  const supabase = getSupabase();
  if (!supabase) return undefined;
  const { data, error } = await supabase
    .from("entrants")
    .select("id, whatsapp_number, leaderboard_username, provider_name, provider_email")
    .eq("whatsapp_number", whatsappPhone)
    .eq("promo_id", promoId)
    .maybeSingle();
  if (error) {
    console.error("[Promo entry] Failed to look up entrant:", error);
    return undefined;
  }
  return (data as EntrantRow) ?? undefined;
}

// Backfills provider_name/provider_email only if not already set — same
// "don't overwrite what we already have" rule as the earlier design, just
// against the real columns. Returns exactly what was newly written (if
// anything), so callers can decide whether it's worth running an identity
// collision check — no point re-checking on every single later submission
// once a name/email is already on file.
async function backfillEntrantIdentity(
  entrant: EntrantRow,
  name: string | null,
  email: string | null
): Promise<{ provider_name?: string; provider_email?: string }> {
  const supabase = getSupabase();
  const patch: { provider_name?: string; provider_email?: string } = {};
  if (!entrant.provider_name && name) patch.provider_name = name;
  if (!entrant.provider_email && email) patch.provider_email = email;
  if (!supabase || Object.keys(patch).length === 0) return {};
  const { error } = await supabase.from("entrants").update(patch).eq("id", entrant.id);
  if (error) {
    console.error("[Promo entry] Failed to backfill entrant identity:", error);
    return {};
  }
  return patch;
}

// Flags a possible multi-account / Sybil pattern: a newly-learned
// provider_name or provider_email that matches a DIFFERENT entrant's
// record for this promo. Never blocks anything — this is purely a signal
// for admin (see server.ts's notifyAgents call on the "logged" result's
// flags) since name/email collisions can also just be coincidence (common
// names) or a genuine second attempt after losing access to a number.
async function checkIdentityCollision(
  promoId: string,
  excludeEntrantId: string | undefined,
  name: string | null,
  email: string | null
): Promise<{ whatsappNumber: string }[]> {
  const supabase = getSupabase();
  if (!supabase || (!name && !email)) return [];

  const matches = new Map<string, string>();

  async function runQuery(column: "provider_email" | "provider_name", value: string) {
    let query = supabase!.from("entrants").select("whatsapp_number").eq("promo_id", promoId).ilike(column, value);
    if (excludeEntrantId) query = query.neq("id", excludeEntrantId);
    const { data, error } = await query;
    if (error) {
      console.error(`[Promo entry] Identity collision check (${column}) failed:`, error);
      return;
    }
    for (const row of (data as { whatsapp_number: string }[] | null) ?? []) {
      matches.set(row.whatsapp_number, row.whatsapp_number);
    }
  }

  if (email) await runQuery("provider_email", email);
  if (name) await runQuery("provider_name", name);

  return Array.from(matches.values()).map((whatsappNumber) => ({ whatsappNumber }));
}

// The account/profile name an entrant said they used for a given
// platform's social actions — asked once (see the awaiting_social_handle
// flow below), reused automatically after that.
async function getStoredSocialHandle(entrantId: string, platform: SocialPlatform): Promise<string | undefined> {
  const supabase = getSupabase();
  if (!supabase) return undefined;
  const { data, error } = await supabase
    .from("entrant_social_handles")
    .select("handle")
    .eq("entrant_id", entrantId)
    .eq("platform", platform)
    .maybeSingle();
  if (error) {
    console.error("[Promo entry] Failed to look up stored social handle:", error);
    return undefined;
  }
  return (data as { handle: string } | null)?.handle ?? undefined;
}

async function saveSocialHandle(entrantId: string, platform: SocialPlatform, handle: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase.from("entrant_social_handles").insert({ entrant_id: entrantId, platform, handle });
  if (error && !isUniqueViolation(error)) {
    // A unique-violation here just means two submissions raced to save the
    // first handle for this platform at the same moment — harmless, one
    // insert wins and the submission still gets logged fine either way.
    console.error("[Promo entry] Failed to save social handle:", error);
  }
}

async function uploadScreenshot(buffer: ArrayBuffer, mimeType: string, whatsappPhone: string): Promise<string | undefined> {
  const supabase = getSupabase();
  if (!supabase) return undefined;
  const ext = mimeType.split("/")[1] || "jpg";
  const path = `${whatsappPhone}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from(PROMO_SCREENSHOT_BUCKET).upload(path, Buffer.from(buffer), {
    contentType: mimeType,
    upsert: false,
  });
  if (error) {
    console.error("[Promo entry] Failed to upload screenshot:", error);
    return undefined;
  }
  return path;
}

// True if this looks like a Postgres unique-violation (code 23505) —
// used to detect a retried WhatsApp webhook delivery hitting the
// whatsapp_message_id unique constraint, a username collision racing past
// the pre-check, or two submissions racing to save the same first social
// handle.
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

// Action types that only make sense claimed ONCE per entrant — you sign up
// once, your profile becomes complete once, you follow an account once.
// Deliberately excludes like_post/comment_post/post_hashtag_content (a
// different post each time is a genuinely new, separate action) and
// booking_completed (a different booking each time). tag_hustlers_comment
// and share_anniversary are tied to "an anniversary post" (singular) in
// their point_rules label, so treated as one-time too.
const ONE_TIME_ACTION_TYPES = new Set<PromoActionType>([
  "signup",
  "complete_profile",
  "list_services",
  "follow_instagram",
  "follow_facebook",
  "follow_tiktok",
  "follow_x",
  "follow_youtube",
  "share_anniversary",
  "tag_hustlers_comment",
]);

// Found via a security/integrity review (2026-09-11): nothing at the
// database level stopped the same entrant re-submitting a one-time action
// and getting paid for it twice if two submissions both happened to get
// approved. The schema already has exactly the right seam for this
// (submissions.status supports a 'duplicate' value and a
// duplicate_of_submission_id FK — admin.html even ships an unused
// "Duplicate" filter chip for it) but nothing was ever writing to it.
// This closes that gap on the bot's side: a second claim for a one-time
// action a given entrant already has pending/approved gets logged (so
// there's still a record/audit trail, and admin can override via the
// existing Duplicate filter) but flagged, never inserted as a fresh
// 'pending' item competing for approval.
async function findExistingOneTimeClaim(entrantId: string, actionType: PromoActionType): Promise<string | undefined> {
  if (!ONE_TIME_ACTION_TYPES.has(actionType)) return undefined;
  const supabase = getSupabase();
  if (!supabase) return undefined;
  const { data, error } = await supabase
    .from("submissions")
    .select("id")
    .eq("entrant_id", entrantId)
    .eq("claimed_action_type", actionType)
    .in("status", ["pending", "approved"])
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[Promo entry] Failed to check for an existing claim:", error);
    return undefined;
  }
  return (data as { id: string } | null)?.id ?? undefined;
}

// Perceptual-hash reuse check: does this screenshot look near-identical to
// one already on file for this promo (possibly from a different entrant)?
// Not an automatic rejection — see the module header. At current/expected
// submission volumes for a 3-month promo, comparing in application code
// against every existing hash is simpler and plenty fast; no need for a
// specialized nearest-neighbor index.
async function findSimilarSubmissionImage(promoId: string, imageHash: string): Promise<string | undefined> {
  const supabase = getSupabase();
  if (!supabase) return undefined;
  const { data, error } = await supabase.from("submissions").select("id, image_hash").eq("promo_id", promoId).not("image_hash", "is", null);
  if (error) {
    console.error("[Promo entry] Failed to load existing image hashes:", error);
    return undefined;
  }
  for (const row of (data as { id: string; image_hash: string | null }[] | null) ?? []) {
    if (row.image_hash && hammingDistance(imageHash, row.image_hash) <= DUPLICATE_HASH_THRESHOLD) {
      return row.id;
    }
  }
  return undefined;
}

async function insertSubmission(params: {
  entrantId: string;
  whatsappPhone: string;
  whatsappMessageId: string;
  screenshotPath: string;
  actionType: PromoActionType;
  targetRef: string | null;
  duplicateOfSubmissionId?: string;
  socialHandle?: string;
  imageHash?: string;
  flaggedImageReuseOf?: string;
  tamperSuspected?: boolean;
  tamperReason?: string | null;
}): Promise<{ status: "logged" } | { status: "already_claimed" } | { status: "duplicate" } | { status: "error" }> {
  const supabase = getSupabase();
  if (!supabase) return { status: "error" };
  const { error } = await supabase.from("submissions").insert({
    entrant_id: params.entrantId,
    whatsapp_message_id: params.whatsappMessageId,
    whatsapp_number: params.whatsappPhone,
    image_url: params.screenshotPath,
    claimed_action_type: params.actionType,
    target_ref: params.targetRef,
    status: params.duplicateOfSubmissionId ? "duplicate" : "pending",
    duplicate_of_submission_id: params.duplicateOfSubmissionId ?? null,
    social_handle: params.socialHandle ?? null,
    image_hash: params.imageHash ?? null,
    flagged_image_reuse_of: params.flaggedImageReuseOf ?? null,
    tamper_suspected: params.tamperSuspected ?? false,
    tamper_reason: params.tamperReason ?? null,
  });
  if (error) {
    if (isUniqueViolation(error)) {
      // Same whatsapp_message_id already logged — a webhook retry, not a
      // new entry. Silent no-op is correct: the customer already got a
      // confirmation the first time. (Different concept from the DB's own
      // 'duplicate' status above — this one never even inserts a new row.)
      return { status: "duplicate" };
    }
    console.error("[Promo entry] Failed to insert submission:", error);
    return { status: "error" };
  }
  return params.duplicateOfSubmissionId ? { status: "already_claimed" } : { status: "logged" };
}

// Advisory signals attached to a successfully-logged submission — every
// one of these is something for admin to look at, never something this
// bot decides on its own. See server.ts for how these turn into an
// internal notifyAgents ping.
export interface EntryFlags {
  tamperSuspected?: boolean;
  tamperReason?: string;
  imageReuseOfSubmissionId?: string;
  identityCollisions?: { whatsappNumber: string }[];
  needsManualBookingConfirmation?: boolean;
}

function buildEntryFlags(
  actionType: PromoActionType,
  result: { tamperSuspected: boolean; tamperReason: string | null },
  imageReuseOfSubmissionId: string | undefined,
  identityCollisions: { whatsappNumber: string }[]
): EntryFlags | undefined {
  const flags: EntryFlags = {};
  if (result.tamperSuspected) {
    flags.tamperSuspected = true;
    if (result.tamperReason) flags.tamperReason = result.tamperReason;
  }
  if (imageReuseOfSubmissionId) flags.imageReuseOfSubmissionId = imageReuseOfSubmissionId;
  if (identityCollisions.length > 0) flags.identityCollisions = identityCollisions;
  if (actionType === "booking_completed") flags.needsManualBookingConfirmation = true;
  return Object.keys(flags).length > 0 ? flags : undefined;
}

// A signup screenshot's "Account verification information" row sometimes
// already reads "Completed" rather than "Pending" — when it does, that SAME
// screenshot is also valid proof of complete_profile (a separate,
// higher-value milestone), so this awards both from the one image instead
// of making the entrant send a second screenshot to prove something
// already visible in the first. Per Tee (2026-09-11). Always logged as its
// own 'pending' submission for admin review — never auto-approved just
// because it rode in on a signup screenshot. Returns undefined if there's
// nothing to award (already claimed, rule missing/inactive, or the insert
// failed) — every case a silent no-bonus, never a hard failure of the
// underlying signup/complete_profile submission it's attached to.
async function maybeAwardBonusCompleteProfile(params: {
  entrantId: string;
  whatsappPhone: string;
  whatsappMessageId: string;
  screenshotPath: string;
  promoId: string;
  imageHash?: string;
}): Promise<{ label: string; points: number } | undefined> {
  const existingClaimId = await findExistingOneTimeClaim(params.entrantId, "complete_profile");
  if (existingClaimId) return undefined;

  const rule = await getPointRule("complete_profile", params.promoId);
  if (!rule || !rule.active) return undefined;

  // Distinct synthetic whatsapp_message_id — the real inbound message ID is
  // already used by the signup submission this rides in on, and that
  // column is unique.
  const insertResult = await insertSubmission({
    entrantId: params.entrantId,
    whatsappPhone: params.whatsappPhone,
    whatsappMessageId: `${params.whatsappMessageId}:complete_profile`,
    screenshotPath: params.screenshotPath,
    actionType: "complete_profile",
    targetRef: null,
    imageHash: params.imageHash,
  });
  if (insertResult.status !== "logged") return undefined;

  console.log(`[Promo entry] Also awarded complete_profile bonus for entrant ${params.entrantId} (verified signup screenshot)`);
  return { label: rule.label, points: rule.points };
}

export interface PendingSubmission {
  whatsappMessageId: string;
  actionType: PromoActionType;
  targetRef: string | null;
  screenshotPath: string;
  extractedName: string | null;
  extractedEmail: string | null;
  platform?: SocialPlatform;
  imageHash?: string;
  imageReuseOfSubmissionId?: string;
  tamperSuspected: boolean;
  tamperReason: string | null;
  identityCollisions: { whatsappNumber: string }[];
  profileVerificationCompleted: boolean;
}

// Held while waiting on a customer's answer to "what account/profile name
// did you use for this?" — entrantId is always known by this point
// (either it already existed, or finalizeUsernameAndSubmission just
// created it), unlike PendingSubmission above.
export interface PendingSocialSubmission {
  entrantId: string;
  whatsappPhone: string;
  whatsappMessageId: string;
  actionType: PromoActionType;
  targetRef: string | null;
  screenshotPath: string;
  platform: SocialPlatform;
  imageHash?: string;
  imageReuseOfSubmissionId?: string;
  tamperSuspected: boolean;
  tamperReason: string | null;
  identityCollisions: { whatsappNumber: string }[];
}

export type PromoEntryResult =
  | { status: "logged"; actionType: PromoActionType; label: string; points: number; flags?: EntryFlags; bonus?: { label: string; points: number } }
  | { status: "awaiting_username"; pending: PendingSubmission }
  | { status: "awaiting_social_handle"; pending: PendingSocialSubmission }
  | { status: "awaiting_clarification"; pending: PendingClarification }
  | { status: "not_entry"; description?: string }
  | { status: "duplicate" }
  | { status: "already_claimed"; label: string; flags?: EntryFlags; bonus?: { label: string; points: number } };

// Held while waiting on a customer's answer to "what is this screenshot
// for?" — the screenshot's already uploaded (see the awaiting_clarification
// branch below) so nothing's lost if they take a while to reply, or resend
// instead. Deliberately minimal compared to PendingSubmission/
// PendingSocialSubmission: at this point we don't yet know actionType,
// platform, or any extracted identity — finalizeClarificationAndSubmission
// re-runs the vision classifier with the customer's own words folded in as
// context, then hands off to the exact same continueWithActionType logic
// every other confident classification uses.
export interface PendingClarification {
  whatsappPhone: string;
  whatsappMessageId: string;
  screenshotPath: string;
  caption?: string;
}

// Everything that happens once we're confident about an actionType — shared
// by processPromoScreenshot's normal path and finalizeClarificationAndSubmission's
// path (a screenshot that only became a confident classification after the
// customer clarified what it was). Kept as one function specifically so
// entrant lookup/creation, one-time-claim checks, and the first-time
// social-handle ask never have two copies that could quietly drift apart.
async function continueWithActionType(params: {
  whatsappPhone: string;
  whatsappMessageId: string;
  actionType: PromoActionType;
  targetRef: string | null;
  screenshotPath: string;
  extractedName: string | null;
  extractedEmail: string | null;
  tamperSuspected: boolean;
  tamperReason: string | null;
  profileVerificationCompleted: boolean;
  promoId: string;
  imageBuffer: ArrayBuffer;
  classifierPlatform?: string | null;
}): Promise<PromoEntryResult> {
  const rule = await getPointRule(params.actionType, params.promoId);
  if (!rule || !rule.active) return { status: "not_entry" };

  const imageHash = await computeImageHash(params.imageBuffer);
  const imageReuseOfSubmissionId = imageHash ? await findSimilarSubmissionImage(params.promoId, imageHash) : undefined;
  const platform = resolvePlatform(params.actionType, params.classifierPlatform ?? null);

  const entrant = await findEntrantByPhone(params.whatsappPhone, params.promoId);

  if (!entrant) {
    const identityCollisions = await checkIdentityCollision(params.promoId, undefined, params.extractedName, params.extractedEmail);
    return {
      status: "awaiting_username",
      pending: {
        whatsappMessageId: params.whatsappMessageId,
        actionType: params.actionType,
        targetRef: params.targetRef,
        screenshotPath: params.screenshotPath,
        extractedName: params.extractedName,
        extractedEmail: params.extractedEmail,
        platform,
        imageHash,
        imageReuseOfSubmissionId,
        tamperSuspected: params.tamperSuspected,
        tamperReason: params.tamperReason,
        identityCollisions,
        profileVerificationCompleted: params.profileVerificationCompleted,
      },
    };
  }

  const backfillPatch = await backfillEntrantIdentity(entrant, params.extractedName, params.extractedEmail);
  const identityCollisions =
    backfillPatch.provider_name || backfillPatch.provider_email
      ? await checkIdentityCollision(params.promoId, entrant.id, backfillPatch.provider_name ?? null, backfillPatch.provider_email ?? null)
      : [];

  const existingClaimId = await findExistingOneTimeClaim(entrant.id, params.actionType);

  let socialHandle: string | undefined;
  if (platform) {
    socialHandle = await getStoredSocialHandle(entrant.id, platform);
    if (!socialHandle && !existingClaimId) {
      // First-ever action on this platform for this entrant, and it's not
      // already a flagged duplicate — worth asking before logging.
      return {
        status: "awaiting_social_handle",
        pending: {
          entrantId: entrant.id,
          whatsappPhone: params.whatsappPhone,
          whatsappMessageId: params.whatsappMessageId,
          actionType: params.actionType,
          targetRef: params.targetRef,
          screenshotPath: params.screenshotPath,
          platform,
          imageHash,
          imageReuseOfSubmissionId,
          tamperSuspected: params.tamperSuspected,
          tamperReason: params.tamperReason,
          identityCollisions,
        },
      };
    }
  }

  const insertResult = await insertSubmission({
    entrantId: entrant.id,
    whatsappPhone: params.whatsappPhone,
    whatsappMessageId: params.whatsappMessageId,
    screenshotPath: params.screenshotPath,
    actionType: params.actionType,
    targetRef: params.targetRef,
    duplicateOfSubmissionId: existingClaimId,
    socialHandle,
    imageHash,
    flaggedImageReuseOf: imageReuseOfSubmissionId,
    tamperSuspected: params.tamperSuspected,
    tamperReason: params.tamperReason,
  });

  if (insertResult.status === "duplicate") return { status: "duplicate" };
  if (insertResult.status === "error") return { status: "not_entry" };

  const flags = buildEntryFlags(
    params.actionType,
    { tamperSuspected: params.tamperSuspected, tamperReason: params.tamperReason },
    imageReuseOfSubmissionId,
    identityCollisions
  );

  // Same screenshot, a second thing to check: a signup screenshot whose
  // "Account verification information" already reads "Completed" is also
  // valid proof of complete_profile — award both from the one image. Runs
  // whether this signup claim is fresh OR a repeat (an entrant might first
  // send this while still "Pending", then resend later once it flips to
  // "Completed" — that resend should still earn the bonus even though
  // signup itself was already claimed).
  const bonus =
    params.actionType === "signup" && params.profileVerificationCompleted
      ? await maybeAwardBonusCompleteProfile({
          entrantId: entrant.id,
          whatsappPhone: params.whatsappPhone,
          whatsappMessageId: params.whatsappMessageId,
          screenshotPath: params.screenshotPath,
          promoId: params.promoId,
          imageHash,
        })
      : undefined;

  if (insertResult.status === "already_claimed") {
    console.log(`[Promo entry] Flagged repeat ${params.actionType} claim from ${params.whatsappPhone} (entrant ${entrant.id}) as duplicate`);
    return { status: "already_claimed", label: rule.label, flags, bonus };
  }

  console.log(`[Promo entry] Logged ${params.actionType} submission for ${params.whatsappPhone} (entrant ${entrant.id})`);
  return { status: "logged", actionType: params.actionType, label: rule.label, points: rule.points, flags, bonus };
}

// The single entry point server.ts calls for an inbound image while the
// promo is live. Downloads once, classifies once. A confident match hands
// off to continueWithActionType above (logged immediately, or held pending
// a leaderboard username / social handle first). Per Tee (2026-09-11):
// every screenshot from now until the promo ends gets checked against our
// app/socials — an unconfident match that still looks like it's FROM our
// app or our own social pages (screenshotSource) gets a clarifying
// question instead of silently falling back to the generic
// image-description flow; only a screenshot that looks unrelated to either
// falls back as before.
export async function processPromoScreenshot(
  whatsappPhone: string,
  mediaId: string,
  whatsappMessageId: string,
  caption?: string
): Promise<PromoEntryResult> {
  const supabase = getSupabase();
  if (!supabase) return { status: "not_entry" };

  const promoId = await getCurrentPromoId();
  if (!promoId) return { status: "not_entry" };

  const downloaded = await downloadWhatsAppMedia(mediaId);
  if (!downloaded) return { status: "not_entry" };

  const result = await classify(downloaded.buffer, downloaded.mimeType, caption);
  if (!result) return { status: "not_entry" };

  const validated = validateClassification(result);
  if (!validated) {
    if (result.screenshotSource === "unclear") {
      return { status: "not_entry", description: result.description };
    }
    const screenshotPath = await uploadScreenshot(downloaded.buffer, downloaded.mimeType, whatsappPhone);
    if (!screenshotPath) return { status: "not_entry", description: result.description };
    return {
      status: "awaiting_clarification",
      pending: { whatsappPhone, whatsappMessageId, screenshotPath, caption },
    };
  }

  const rule = await getPointRule(validated.actionType, promoId);
  if (!rule || !rule.active) return { status: "not_entry", description: result.description };

  const screenshotPath = await uploadScreenshot(downloaded.buffer, downloaded.mimeType, whatsappPhone);
  if (!screenshotPath) return { status: "not_entry", description: result.description };

  return continueWithActionType({
    whatsappPhone,
    whatsappMessageId,
    actionType: validated.actionType,
    targetRef: result.targetRef,
    screenshotPath,
    extractedName: result.extractedName,
    extractedEmail: result.extractedEmail,
    tamperSuspected: result.tamperSuspected,
    tamperReason: result.tamperReason,
    profileVerificationCompleted: result.profileVerificationCompleted,
    promoId,
    imageBuffer: downloaded.buffer,
    classifierPlatform: result.platform,
  });
}

// Re-downloads an already-uploaded screenshot from the private Supabase
// bucket — needed when finishing a clarification, since the customer's
// answer arrives as a separate WhatsApp message and the original in-memory
// image buffer from processPromoScreenshot is long gone by then.
async function downloadStoredScreenshot(path: string): Promise<{ buffer: ArrayBuffer; mimeType: string } | undefined> {
  const supabase = getSupabase();
  if (!supabase) return undefined;
  const { data, error } = await supabase.storage.from(PROMO_SCREENSHOT_BUCKET).download(path);
  if (error || !data) {
    console.error("[Promo entry] Failed to download stored screenshot for re-classification:", error);
    return undefined;
  }
  const buffer = await data.arrayBuffer();
  const ext = path.split(".").pop()?.toLowerCase();
  const mimeType =
    ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
  return { buffer, mimeType };
}

// Called once a customer answers the bot's "what is this screenshot for?"
// question (see buildClarificationPrompt / server.ts's awaitingPromoClarification
// check). Re-runs the same vision classifier against the same image, with
// the customer's own words folded in as extra context — the most reliable
// way to resolve the ambiguity, since it lets the model actually look at
// the image again in light of what the customer says it is, rather than
// this code guessing from keywords alone. Falls through to not_entry
// (still can't tell, or the customer said it isn't promo-related) if that
// still doesn't produce a confident match.
export async function finalizeClarificationAndSubmission(
  pending: PendingClarification,
  rawReply: string
): Promise<PromoEntryResult> {
  const supabase = getSupabase();
  if (!supabase) return { status: "not_entry" };

  const promoId = await getCurrentPromoId();
  if (!promoId) return { status: "not_entry" };

  const downloaded = await downloadStoredScreenshot(pending.screenshotPath);
  if (!downloaded) return { status: "not_entry" };

  const clarifiedCaption = `${pending.caption ? pending.caption + " " : ""}[The sender was asked what this screenshot is for the Hustle @1 promo, and replied: "${rawReply.trim()}"]`;
  const result = await classify(downloaded.buffer, downloaded.mimeType, clarifiedCaption);
  if (!result) return { status: "not_entry" };

  const validated = validateClassification(result);
  if (!validated) return { status: "not_entry", description: result.description };

  const rule = await getPointRule(validated.actionType, promoId);
  if (!rule || !rule.active) return { status: "not_entry", description: result.description };

  return continueWithActionType({
    whatsappPhone: pending.whatsappPhone,
    whatsappMessageId: pending.whatsappMessageId,
    actionType: validated.actionType,
    targetRef: result.targetRef,
    screenshotPath: pending.screenshotPath,
    extractedName: result.extractedName,
    extractedEmail: result.extractedEmail,
    tamperSuspected: result.tamperSuspected,
    tamperReason: result.tamperReason,
    profileVerificationCompleted: result.profileVerificationCompleted,
    promoId,
    imageBuffer: downloaded.buffer,
    classifierPlatform: result.platform,
  });
}

export type FinalizeUsernameResult =
  | { status: "logged"; actionType: PromoActionType; label: string; points: number; flags?: EntryFlags; bonus?: { label: string; points: number } }
  | { status: "awaiting_social_handle"; pending: PendingSocialSubmission }
  | { status: "taken" }
  | { status: "invalid" }
  | { status: "duplicate" }
  | { status: "error" };

// Called once a customer replies with their chosen leaderboard username to
// the bot's follow-up question (see server.ts's awaitingLeaderboardUsername
// check). Creates the entrant, then either asks for a social handle first
// (if the pending action is a first-time social one) or logs the held
// submission straight away — the unique index on
// (promo_id, lower(leaderboard_username)) is the real backstop against a
// race between the pre-check and the insert, not just the pre-check itself.
export async function finalizeUsernameAndSubmission(
  whatsappPhone: string,
  pending: PendingSubmission,
  rawUsername: string
): Promise<FinalizeUsernameResult> {
  const supabase = getSupabase();
  if (!supabase) return { status: "error" };

  const username = validateUsername(rawUsername);
  if (!username) return { status: "invalid" };

  const promoId = await getCurrentPromoId();
  if (!promoId) return { status: "error" };

  const { data: existingUsername, error: usernameErr } = await supabase
    .from("entrants")
    .select("id")
    .eq("promo_id", promoId)
    .ilike("leaderboard_username", username)
    .maybeSingle();
  if (usernameErr) {
    console.error("[Promo entry] Username availability check failed:", usernameErr);
    return { status: "error" };
  }
  if (existingUsername) return { status: "taken" };

  const { data: created, error: createErr } = await supabase
    .from("entrants")
    .insert({
      whatsapp_number: whatsappPhone,
      leaderboard_username: username,
      provider_name: pending.extractedName,
      provider_email: pending.extractedEmail,
      status: "pending_verification",
      promo_id: promoId,
    })
    .select("id")
    .single();

  if (createErr) {
    if (isUniqueViolation(createErr)) return { status: "taken" };
    console.error("[Promo entry] Failed to create entrant:", createErr);
    return { status: "error" };
  }

  if (pending.platform) {
    // Brand-new entrant, so there's never a stored handle for any
    // platform yet — always need to ask before this specific submission
    // can be logged.
    return {
      status: "awaiting_social_handle",
      pending: {
        entrantId: created.id,
        whatsappPhone,
        whatsappMessageId: pending.whatsappMessageId,
        actionType: pending.actionType,
        targetRef: pending.targetRef,
        screenshotPath: pending.screenshotPath,
        platform: pending.platform,
        imageHash: pending.imageHash,
        imageReuseOfSubmissionId: pending.imageReuseOfSubmissionId,
        tamperSuspected: pending.tamperSuspected,
        tamperReason: pending.tamperReason,
        identityCollisions: pending.identityCollisions,
      },
    };
  }

  const rule = await getPointRule(pending.actionType, promoId);
  if (!rule) return { status: "error" };

  const insertResult = await insertSubmission({
    entrantId: created.id,
    whatsappPhone,
    whatsappMessageId: pending.whatsappMessageId,
    screenshotPath: pending.screenshotPath,
    actionType: pending.actionType,
    targetRef: pending.targetRef,
    imageHash: pending.imageHash,
    flaggedImageReuseOf: pending.imageReuseOfSubmissionId,
    tamperSuspected: pending.tamperSuspected,
    tamperReason: pending.tamperReason,
  });

  if (insertResult.status === "duplicate") return { status: "duplicate" };
  if (insertResult.status === "error") return { status: "error" };

  const flags = buildEntryFlags(pending.actionType, pending, pending.imageReuseOfSubmissionId, pending.identityCollisions);

  // Same bonus check as processPromoScreenshot's existing-entrant path —
  // see maybeAwardBonusCompleteProfile's header comment. A brand-new
  // entrant can't have an existing complete_profile claim yet, but the
  // helper's own findExistingOneTimeClaim check covers that regardless.
  const bonus =
    pending.actionType === "signup" && pending.profileVerificationCompleted
      ? await maybeAwardBonusCompleteProfile({
          entrantId: created.id,
          whatsappPhone,
          whatsappMessageId: pending.whatsappMessageId,
          screenshotPath: pending.screenshotPath,
          promoId,
          imageHash: pending.imageHash,
        })
      : undefined;

  console.log(`[Promo entry] Created entrant ${created.id} (${username}) and logged ${pending.actionType} for ${whatsappPhone}`);
  return { status: "logged", actionType: pending.actionType, label: rule.label, points: rule.points, flags, bonus };
}

export type FinalizeSocialHandleResult =
  | { status: "logged"; actionType: PromoActionType; label: string; points: number; flags?: EntryFlags }
  | { status: "invalid" }
  | { status: "duplicate" }
  | { status: "error" };

// Called once a customer replies with the account/profile name they used,
// answering the bot's awaiting_social_handle question (see server.ts).
// Saves it once per (entrant, platform) — every later action on the same
// platform reuses it automatically via getStoredSocialHandle above,
// without ever asking again.
export async function finalizeSocialHandleAndSubmission(
  pending: PendingSocialSubmission,
  rawHandle: string
): Promise<FinalizeSocialHandleResult> {
  const supabase = getSupabase();
  if (!supabase) return { status: "error" };

  const handle = validateSocialHandle(rawHandle);
  if (!handle) return { status: "invalid" };

  const promoId = await getCurrentPromoId();
  if (!promoId) return { status: "error" };

  await saveSocialHandle(pending.entrantId, pending.platform, handle);

  const rule = await getPointRule(pending.actionType, promoId);
  if (!rule) return { status: "error" };

  const insertResult = await insertSubmission({
    entrantId: pending.entrantId,
    whatsappPhone: pending.whatsappPhone,
    whatsappMessageId: pending.whatsappMessageId,
    screenshotPath: pending.screenshotPath,
    actionType: pending.actionType,
    targetRef: pending.targetRef,
    socialHandle: handle,
    imageHash: pending.imageHash,
    flaggedImageReuseOf: pending.imageReuseOfSubmissionId,
    tamperSuspected: pending.tamperSuspected,
    tamperReason: pending.tamperReason,
  });

  if (insertResult.status === "duplicate") return { status: "duplicate" };
  if (insertResult.status === "error") return { status: "error" };

  const flags = buildEntryFlags(pending.actionType, pending, pending.imageReuseOfSubmissionId, pending.identityCollisions);

  console.log(
    `[Promo entry] Saved ${pending.platform} handle "${handle}" and logged ${pending.actionType} for entrant ${pending.entrantId}`
  );
  return { status: "logged", actionType: pending.actionType, label: rule.label, points: rule.points, flags };
}

export function buildPromoEntryConfirmation(
  label: string,
  points: number,
  bonus?: { label: string; points: number }
): string {
  if (!bonus) {
    return `Got it — logged your entry for "${label}" (+${points} points) in the Hustle @1 promo! 🎉 Our team will review it and confirm soon.`;
  }
  const total = points + bonus.points;
  return `Got it — logged your entry for "${label}" (+${points} points)! And since this screenshot also shows your profile as verified, that counts as "${bonus.label}" too (+${bonus.points} points) — that's ${total} points total. 🎉 Our team will review it and confirm soon.`;
}

// Sent when findExistingOneTimeClaim caught a repeat claim on a one-time
// action — still recorded (status: 'duplicate' in the DB, visible to admin
// via the existing Duplicate filter) but not treated as a fresh entry, so
// the customer needs an honest, non-confusing reply rather than the usual
// celebratory confirmation.
export function buildAlreadyClaimedReply(label: string, bonus?: { label: string; points: number }): string {
  const base = `Looks like you've already got credit for "${label}" in the Hustle @1 promo — no need to resend that one.`;
  if (!bonus) return `${base} If that seems wrong, just say "agent" and we'll take a look.`;
  return `${base} Good news though — this screenshot also shows your profile as verified, so I've logged "${bonus.label}" (+${bonus.points} points) for you too! 🎉 Our team will review it and confirm soon.`;
}

export function buildUsernamePrompt(): string {
  return "One more thing — what username would you like to appear as on the public leaderboard? Pick something unique (2–24 characters).";
}

export function buildSocialHandlePrompt(platform: SocialPlatform): string {
  return `Quick one — what's the ${PLATFORM_LABELS[platform]} account/profile name you used for this? We'll log it so our team can double check, and you won't need to give it again for future ${PLATFORM_LABELS[platform]} entries.`;
}

export function buildClarificationPrompt(): string {
  return (
    'This looks like it might be from the Hustleapp app or one of our social pages, but I\'m not sure exactly what it\'s showing — could you tell me what this is for the Hustle @1 promo? For example: "signed up", "completed my profile", "listed my services", "a completed booking", or which social page (Instagram/Facebook/TikTok/X/YouTube) and what you did there (followed, liked, commented, shared). Reply "not related" if this isn\'t for the promo.'
  );
}

// Sent when finalizeClarificationAndSubmission still couldn't pin down a
// confident action after the customer's own explanation — either they said
// it isn't promo-related, or the second look still wasn't clear enough.
// Either way it's an honest "we're not logging this one" rather than a
// silent drop, since the customer was explicitly asked and deserves a
// real answer back.
export function buildClarificationDeclinedReply(): string {
  return 'No worries — I won\'t log that one for the promo. If you think it should count, just say "agent" and a person will take a look.';
}

// --- Approval notifications ---
// admin.html's approveSubmission (a separate app, outside this repo) is
// the only thing that ever flips submissions.status to 'approved' — this
// bot never does. So rather than hooking into that action directly, a
// sweep (see server.ts's startPromoApprovalNotifySweep) polls for
// newly-approved submissions the customer hasn't been told about yet, using
// approval_notified_at as the "already told them" marker. Per Tee
// (2026-09-11): send a WhatsApp confirmation plus the leaderboard link the
// moment a submission is approved, instead of the customer only finding
// out if they think to ask "what's my score?".

export interface ApprovedSubmissionForNotify {
  submissionId: string;
  whatsappPhone: string;
  actionType: PromoActionType;
  label: string;
  points: number;
}

interface UnnotifiedSubmissionRow {
  id: string;
  whatsapp_number: string;
  claimed_action_type: string | null;
}

export async function getUnnotifiedApprovedSubmissions(): Promise<ApprovedSubmissionForNotify[]> {
  const supabase = getSupabase();
  if (!supabase) return [];
  const promoId = await getCurrentPromoId();
  if (!promoId) return [];

  const { data, error } = await supabase
    .from("submissions")
    .select("id, whatsapp_number, claimed_action_type")
    .eq("promo_id", promoId)
    .eq("status", "approved")
    .is("approval_notified_at", null);

  if (error) {
    console.error("[Promo entry] Failed to load newly-approved submissions:", error);
    return [];
  }

  const results: ApprovedSubmissionForNotify[] = [];
  for (const row of (data ?? []) as UnnotifiedSubmissionRow[]) {
    // Shouldn't happen (every submission claims an action type on the way
    // in), but skip rather than crash the sweep over one odd row.
    if (!row.claimed_action_type) continue;
    const rule = await getPointRule(row.claimed_action_type as PromoActionType, promoId);
    if (!rule) continue;
    results.push({
      submissionId: row.id,
      whatsappPhone: row.whatsapp_number,
      actionType: row.claimed_action_type as PromoActionType,
      label: rule.label,
      points: rule.points,
    });
  }
  return results;
}

export async function markApprovalNotified(submissionId: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase
    .from("submissions")
    .update({ approval_notified_at: new Date().toISOString() })
    .eq("id", submissionId);
  if (error) console.error("[Promo entry] Failed to mark approval notified:", error);
}

// standingSentence, when given, is a ready-made sentence from
// promoLeaderboard.ts's buildPromoStandingReply (e.g. "You're 3rd out of 12
// on the Hustle @1 leaderboard, with 45 points as \"username\"...") — built
// there rather than here to avoid a circular import (promoLeaderboard.ts
// already imports getCurrentPromoId/findEntrantByPhone from this file) and
// to reuse the exact same rank-formatting logic the "what's my score?"
// reply uses, instead of a second copy that could drift from it.
export function buildApprovalNotification(label: string, points: number, standingSentence?: string): string {
  const base = `Great news — your "${label}" entry (+${points} points) for the Hustle @1 promo has been approved! 🎉`;
  const standingPart = standingSentence ? ` ${standingSentence}` : "";
  return `${base}${standingPart} Check the full leaderboard anytime: http://promos.hustleapp.io/promo/hustle-at-1`;
}
