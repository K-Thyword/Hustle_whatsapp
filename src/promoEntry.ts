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
- "complete_profile": specifically their Hustleapp profile shown as 100% / fully complete (a distinct, later milestone from signup above) — these typically show their own name AND email alongside an explicit completion indicator. Don't confuse this with the general Account Settings screen described under "signup" — that one counts as signup even when incomplete.
- "follow_instagram" / "follow_facebook" / "follow_tiktok" / "follow_x" / "follow_youtube": proof they follow HustleApp's account on that SPECIFIC platform — e.g. "Following" shown on Hustleapp's page, or Hustleapp appearing in their own following list. Pick the exact platform, don't guess if unclear.
- "like_post": proof they liked one of HustleApp's social posts.
- "comment_post": proof they commented on one of HustleApp's social posts. If a post URL/permalink is visible, put it in targetRef.
- "post_hashtag_content": a post THEY made on social media, tagged #HustleAppTurns1.
- "share_anniversary": proof they shared HustleApp's anniversary announcement post, tagged @hustleapp.
- "tag_hustlers_comment": proof they tagged 3 other hustlers in the comments of an anniversary post.
- "booking_completed": a completed AND PAID booking/job on the Hustleapp platform (e.g. a payment confirmation or "job complete" screen).

If the image doesn't clearly match one of these — a random photo, an unrelated screenshot, a job-site photo, anything ambiguous — set isPromoEntry to false and actionType to null.

Also extract, only when actually legible in the image (never guess or infer):
- extractedName: a personal name that plausibly belongs to whoever took this screenshot (e.g. in a profile header, a "Welcome, X" banner, or as a comment/post author).
- extractedEmail: an email address, if visible.
- targetRef: a post URL, permalink, or other reference identifying the SPECIFIC post involved (relevant mainly for comment_post/like_post/share_anniversary) — null if nothing like that is visible.
- platform: which social platform this screenshot is FROM, if it's a social action (like_post/comment_post/post_hashtag_content/share_anniversary/tag_hustlers_comment) — one of "instagram", "facebook", "tiktok", "x", "youtube", based on the visible UI style/branding or a URL shown, or null if you genuinely can't tell. (For the follow_* action types the platform is already implied by the action type itself — you can still fill this in the same way, but it won't be relied on there.)

Also assess, honestly and conservatively:
- tamperSuspected: true only if you see clear, concrete signs of digital editing — mismatched fonts, misaligned/duplicated UI elements, inconsistent lighting or pixel artifacts around text, a screenshot-of-a-screenshot moiré pattern, or a resolution/aspect-ratio that doesn't match the claimed app's real UI. Do NOT set this true just because something is merely hard to read, oddly cropped, or a normal photo of a phone screen (glare, an angled photo, a slightly blurry photo, or a boring crop are all normal, not tampering) — false accusations of editing are worse than missing real ones, since a real person will actually see and read this.
- tamperReason: one short plain sentence explaining why, only if tamperSuspected is true — otherwise null.

Respond with strict JSON only, no markdown formatting, matching exactly:
{"isPromoEntry": boolean, "actionType": string|null, "targetRef": string|null, "confidence": number (0-1), "extractedName": string|null, "extractedEmail": string|null, "platform": string|null, "tamperSuspected": boolean, "tamperReason": string|null, "description": string (always fill this in — 1 short plain-English sentence describing the image, used as a fallback if this isn't treated as a promo entry)}`;

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
  | { status: "logged"; actionType: PromoActionType; label: string; points: number; flags?: EntryFlags }
  | { status: "awaiting_username"; pending: PendingSubmission }
  | { status: "awaiting_social_handle"; pending: PendingSocialSubmission }
  | { status: "not_entry"; description?: string }
  | { status: "duplicate" }
  | { status: "already_claimed"; label: string; flags?: EntryFlags };

// The single entry point server.ts calls for an inbound image while the
// promo is live. Downloads once, classifies once, and only for a
// confident match does anything further happen. A phone with an existing
// entrant gets logged immediately (unless it's their first-ever action on
// a given social platform, in which case the account name gets asked for
// first); a brand-new phone gets its screenshot uploaded and
// classification held as "pending" while the bot asks for a leaderboard
// username first (see finalizeUsernameAndSubmission below) — nothing
// about the vision call needs to run twice for any of this.
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
  if (!validated) return { status: "not_entry", description: result.description };
  const { actionType } = validated;

  const rule = await getPointRule(actionType, promoId);
  if (!rule || !rule.active) return { status: "not_entry", description: result.description };

  const screenshotPath = await uploadScreenshot(downloaded.buffer, downloaded.mimeType, whatsappPhone);
  if (!screenshotPath) return { status: "not_entry", description: result.description };

  const imageHash = await computeImageHash(downloaded.buffer);
  const imageReuseOfSubmissionId = imageHash ? await findSimilarSubmissionImage(promoId, imageHash) : undefined;
  const platform = resolvePlatform(actionType, result.platform);

  const entrant = await findEntrantByPhone(whatsappPhone, promoId);

  if (!entrant) {
    const identityCollisions = await checkIdentityCollision(promoId, undefined, result.extractedName, result.extractedEmail);
    return {
      status: "awaiting_username",
      pending: {
        whatsappMessageId,
        actionType,
        targetRef: result.targetRef,
        screenshotPath,
        extractedName: result.extractedName,
        extractedEmail: result.extractedEmail,
        platform,
        imageHash,
        imageReuseOfSubmissionId,
        tamperSuspected: result.tamperSuspected,
        tamperReason: result.tamperReason,
        identityCollisions,
      },
    };
  }

  const backfillPatch = await backfillEntrantIdentity(entrant, result.extractedName, result.extractedEmail);
  const identityCollisions =
    backfillPatch.provider_name || backfillPatch.provider_email
      ? await checkIdentityCollision(promoId, entrant.id, backfillPatch.provider_name ?? null, backfillPatch.provider_email ?? null)
      : [];

  const existingClaimId = await findExistingOneTimeClaim(entrant.id, actionType);

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
          whatsappPhone,
          whatsappMessageId,
          actionType,
          targetRef: result.targetRef,
          screenshotPath,
          platform,
          imageHash,
          imageReuseOfSubmissionId,
          tamperSuspected: result.tamperSuspected,
          tamperReason: result.tamperReason,
          identityCollisions,
        },
      };
    }
  }

  const insertResult = await insertSubmission({
    entrantId: entrant.id,
    whatsappPhone,
    whatsappMessageId,
    screenshotPath,
    actionType,
    targetRef: result.targetRef,
    duplicateOfSubmissionId: existingClaimId,
    socialHandle,
    imageHash,
    flaggedImageReuseOf: imageReuseOfSubmissionId,
    tamperSuspected: result.tamperSuspected,
    tamperReason: result.tamperReason,
  });

  if (insertResult.status === "duplicate") return { status: "duplicate" };
  if (insertResult.status === "error") return { status: "not_entry", description: result.description };

  const flags = buildEntryFlags(actionType, result, imageReuseOfSubmissionId, identityCollisions);

  if (insertResult.status === "already_claimed") {
    console.log(`[Promo entry] Flagged repeat ${actionType} claim from ${whatsappPhone} (entrant ${entrant.id}) as duplicate`);
    return { status: "already_claimed", label: rule.label, flags };
  }

  console.log(`[Promo entry] Logged ${actionType} submission for ${whatsappPhone} (entrant ${entrant.id})`);
  return { status: "logged", actionType, label: rule.label, points: rule.points, flags };
}

export type FinalizeUsernameResult =
  | { status: "logged"; actionType: PromoActionType; label: string; points: number; flags?: EntryFlags }
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

  console.log(`[Promo entry] Created entrant ${created.id} (${username}) and logged ${pending.actionType} for ${whatsappPhone}`);
  return { status: "logged", actionType: pending.actionType, label: rule.label, points: rule.points, flags };
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

export function buildPromoEntryConfirmation(label: string, points: number): string {
  return `Got it — logged your entry for "${label}" (+${points} points) in the Hustle @1 promo! 🎉 Our team will review it and confirm soon.`;
}

// Sent when findExistingOneTimeClaim caught a repeat claim on a one-time
// action — still recorded (status: 'duplicate' in the DB, visible to admin
// via the existing Duplicate filter) but not treated as a fresh entry, so
// the customer needs an honest, non-confusing reply rather than the usual
// celebratory confirmation.
export function buildAlreadyClaimedReply(label: string): string {
  return `Looks like you've already got credit for "${label}" in the Hustle @1 promo — no need to resend that one. If that seems wrong, just say "agent" and we'll take a look.`;
}

export function buildUsernamePrompt(): string {
  return "One more thing — what username would you like to appear as on the public leaderboard? Pick something unique (2–24 characters).";
}

export function buildSocialHandlePrompt(platform: SocialPlatform): string {
  return `Quick one — what's the ${PLATFORM_LABELS[platform]} account/profile name you used for this? We'll log it so our team can double check, and you won't need to give it again for future ${PLATFORM_LABELS[platform]} entries.`;
}
