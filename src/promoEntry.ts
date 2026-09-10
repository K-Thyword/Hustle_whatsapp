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
// phone) and `submissions` (status: 'pending'). It never touches
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

import Anthropic from "@anthropic-ai/sdk";
import { downloadWhatsAppMedia } from "./whatsappMedia";
import { getSupabase, PROMO_SCREENSHOT_BUCKET } from "./supabase";

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
  description: string;
}

function normalizeMimeType(mimeType: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  const supported = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  return (supported.includes(mimeType) ? mimeType : "image/jpeg") as never;
}

const CLASSIFY_PROMPT = `You're screening WhatsApp screenshots for Hustleapp's "Hustle @1" anniversary promo. Registered Hustlers (service providers) earn points by doing one of these things and sending a screenshot as proof:

- "signup": a screenshot showing they just created a Hustleapp Hustler account (e.g. a welcome/registration-success screen).
- "complete_profile": their Hustleapp profile shown as complete (e.g. a "100%"/"profile complete" screen) — these typically show their own name AND email.
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

Respond with strict JSON only, no markdown formatting, matching exactly:
{"isPromoEntry": boolean, "actionType": string|null, "targetRef": string|null, "confidence": number (0-1), "extractedName": string|null, "extractedEmail": string|null, "description": string (always fill this in — 1 short plain-English sentence describing the image, used as a fallback if this isn't treated as a promo entry)}`;

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

interface PromoRow {
  id: string;
}

let cachedPromo: { id: string; cachedAt: number } | null = null;
const PROMO_CACHE_MS = 5 * 60 * 1000;

async function getCurrentPromoId(): Promise<string | undefined> {
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

async function findEntrantByPhone(whatsappPhone: string, promoId: string): Promise<EntrantRow | undefined> {
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
// against the real columns.
async function backfillEntrantIdentity(entrant: EntrantRow, name: string | null, email: string | null): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  const patch: Partial<Pick<EntrantRow, "provider_name" | "provider_email">> = {};
  if (!entrant.provider_name && name) patch.provider_name = name;
  if (!entrant.provider_email && email) patch.provider_email = email;
  if (Object.keys(patch).length === 0) return;
  const { error } = await supabase.from("entrants").update(patch).eq("id", entrant.id);
  if (error) console.error("[Promo entry] Failed to backfill entrant identity:", error);
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
// whatsapp_message_id unique constraint, or a username collision racing
// past the pre-check against entrants_promo_username_unique.
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

async function insertSubmission(params: {
  entrantId: string;
  whatsappPhone: string;
  whatsappMessageId: string;
  screenshotPath: string;
  actionType: PromoActionType;
  targetRef: string | null;
}): Promise<{ status: "logged" } | { status: "duplicate" } | { status: "error" }> {
  const supabase = getSupabase();
  if (!supabase) return { status: "error" };
  const { error } = await supabase.from("submissions").insert({
    entrant_id: params.entrantId,
    whatsapp_message_id: params.whatsappMessageId,
    whatsapp_number: params.whatsappPhone,
    image_url: params.screenshotPath,
    claimed_action_type: params.actionType,
    target_ref: params.targetRef,
    status: "pending",
  });
  if (error) {
    if (isUniqueViolation(error)) {
      // Same whatsapp_message_id already logged — a webhook retry, not a
      // new entry. Silent no-op is correct: the customer already got a
      // confirmation the first time.
      return { status: "duplicate" };
    }
    console.error("[Promo entry] Failed to insert submission:", error);
    return { status: "error" };
  }
  return { status: "logged" };
}

export interface PendingSubmission {
  whatsappMessageId: string;
  actionType: PromoActionType;
  targetRef: string | null;
  screenshotPath: string;
  extractedName: string | null;
  extractedEmail: string | null;
}

export type PromoEntryResult =
  | { status: "logged"; actionType: PromoActionType; label: string; points: number }
  | { status: "awaiting_username"; pending: PendingSubmission }
  | { status: "not_entry"; description?: string }
  | { status: "duplicate" };

// The single entry point server.ts calls for an inbound image while the
// promo is live. Downloads once, classifies once, and only for a
// confident match does anything further happen. A phone with an existing
// entrant gets logged immediately; a brand-new phone gets its screenshot
// uploaded and classification held as "pending" while the bot asks for a
// leaderboard username (see finalizeUsernameAndSubmission below) — nothing
// about the vision call needs to run twice for that.
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

  const entrant = await findEntrantByPhone(whatsappPhone, promoId);

  if (!entrant) {
    return {
      status: "awaiting_username",
      pending: {
        whatsappMessageId,
        actionType,
        targetRef: result.targetRef,
        screenshotPath,
        extractedName: result.extractedName,
        extractedEmail: result.extractedEmail,
      },
    };
  }

  await backfillEntrantIdentity(entrant, result.extractedName, result.extractedEmail);

  const insertResult = await insertSubmission({
    entrantId: entrant.id,
    whatsappPhone,
    whatsappMessageId,
    screenshotPath,
    actionType,
    targetRef: result.targetRef,
  });

  if (insertResult.status === "duplicate") return { status: "duplicate" };
  if (insertResult.status === "error") return { status: "not_entry", description: result.description };

  console.log(`[Promo entry] Logged ${actionType} submission for ${whatsappPhone} (entrant ${entrant.id})`);
  return { status: "logged", actionType, label: rule.label, points: rule.points };
}

export type FinalizeUsernameResult =
  | { status: "logged"; actionType: PromoActionType; label: string; points: number }
  | { status: "taken" }
  | { status: "invalid" }
  | { status: "duplicate" }
  | { status: "error" };

// Called once a customer replies with their chosen leaderboard username to
// the bot's follow-up question (see server.ts's awaitingLeaderboardUsername
// check). Creates the entrant, then the held submission, in that order —
// the unique index on (promo_id, lower(leaderboard_username)) is the real
// backstop against a race between the pre-check and the insert, not just
// the pre-check itself.
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

  const rule = await getPointRule(pending.actionType, promoId);
  if (!rule) return { status: "error" };

  const insertResult = await insertSubmission({
    entrantId: created.id,
    whatsappPhone,
    whatsappMessageId: pending.whatsappMessageId,
    screenshotPath: pending.screenshotPath,
    actionType: pending.actionType,
    targetRef: pending.targetRef,
  });

  if (insertResult.status === "duplicate") return { status: "duplicate" };
  if (insertResult.status === "error") return { status: "error" };

  console.log(`[Promo entry] Created entrant ${created.id} (${username}) and logged ${pending.actionType} for ${whatsappPhone}`);
  return { status: "logged", actionType: pending.actionType, label: rule.label, points: rule.points };
}

export function buildPromoEntryConfirmation(label: string, points: number): string {
  return `Got it — logged your entry for "${label}" (+${points} points) in the Hustle @1 promo! 🎉 Our team will review it and confirm soon.`;
}

export function buildUsernamePrompt(): string {
  return "One more thing — what username would you like to appear as on the public leaderboard? Pick something unique (2–24 characters).";
}
