// "Hustle @1" promo entry pipeline — the bot's side of
// docs/prd/0001-hustle-at-1-entry-system.md. A customer sends a screenshot
// while the promo is live; one Claude vision call decides whether it's a
// promo entry and, if so, which category and what identity text is visible
// on it (see §3 of the PRD for why identity extraction — not phone number —
// is the primary matching key). If it is an entry, the screenshot bytes get
// uploaded to this promo's own Supabase project (a SEPARATE database from
// the main Hustleapp app — see supabase.ts) and logged as `pending`; an
// admin reviews and approves it later (not built yet — see PRD phasing).
//
// Deliberately mirrors imageAnalyzer.ts's conservative-fallback shape:
// every function here degrades to "treat this as a normal image" rather
// than throwing, so a classifier or Supabase hiccup never breaks the
// booking flow a customer might otherwise be in the middle of.

import Anthropic from "@anthropic-ai/sdk";
import { downloadWhatsAppMedia } from "./whatsappMedia";
import { getSupabase, PROMO_SCREENSHOT_BUCKET } from "./supabase";

const hasRealKey =
  process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== "from-console.anthropic.com";
const anthropic = hasRealKey ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

export type PromoCategory =
  | "signup"
  | "profile_complete"
  | "social_follow"
  | "content_post"
  | "share"
  | "like_comment"
  | "booking";

const PROMO_CATEGORIES: PromoCategory[] = [
  "signup",
  "profile_complete",
  "social_follow",
  "content_post",
  "share",
  "like_comment",
  "booking",
];

const VALID_DETAILS: Partial<Record<PromoCategory, string[]>> = {
  social_follow: ["instagram", "facebook", "tiktok", "x", "youtube"],
  like_comment: ["like", "comment"],
};

// Chosen conservatively: a false negative (a real entry gets treated as a
// normal photo) just falls back to the existing description flow — the
// customer can resend, or the promo's own care line still works — while a
// false positive (a random photo silently logged as a "pending" entry)
// pollutes the review queue and could look like an accepted claim before a
// human ever looks at it. Cheap to raise/lower later once real submissions
// show how the classifier actually performs (ai_raw_response is kept on
// every row specifically to make that tuning possible).
const CONFIDENCE_THRESHOLD = 0.55;

interface RawClassification {
  isPromoEntry: boolean;
  category: string | null;
  categoryDetail: string | null;
  confidence: number;
  extractedName: string | null;
  extractedEmail: string | null;
  bookingReference: string | null;
  description: string;
}

function normalizeMimeType(mimeType: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  const supported = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  return (supported.includes(mimeType) ? mimeType : "image/jpeg") as never;
}

const CLASSIFY_PROMPT = `You're screening WhatsApp screenshots for Hustleapp's "Hustle @1" anniversary promo. Registered Hustlers (service providers) earn points by doing one of these things and sending a screenshot as proof:

- "signup": a screenshot showing they just created a Hustleapp Hustler account (e.g. a welcome/registration-success screen).
- "profile_complete": their Hustleapp profile shown as complete (e.g. a "100%"/"profile complete" screen) — these typically show their own name AND email.
- "social_follow": proof they follow one of Hustleapp's social accounts (Instagram, Facebook, TikTok, X, YouTube) — e.g. "Following" shown on Hustleapp's account page, or Hustleapp appearing in their own following list. Set categoryDetail to whichever platform: "instagram" | "facebook" | "tiktok" | "x" | "youtube".
- "content_post": a post THEY made on social media, tagged #HustleAppTurns1.
- "share": proof they shared Hustleapp's anniversary announcement post.
- "like_comment": proof they liked or commented on one of Hustleapp's social posts. Set categoryDetail to "like" or "comment".
- "booking": a completed AND PAID booking/job on the Hustleapp platform (e.g. a payment confirmation or "job complete" screen).

If the image doesn't clearly match one of these — a random photo, an unrelated screenshot, a job-site photo, anything ambiguous — set isPromoEntry to false and category to null.

Also extract, only when actually legible in the image (never guess or infer):
- extractedName: a personal name that plausibly belongs to whoever took this screenshot (e.g. in a profile header, a "Welcome, X" banner, or as a comment/post author).
- extractedEmail: an email address, if visible.
- bookingReference: a booking/job/order reference or ID, ONLY relevant for category "booking".

Respond with strict JSON only, no markdown formatting, matching exactly:
{"isPromoEntry": boolean, "category": string|null, "categoryDetail": string|null, "confidence": number (0-1), "extractedName": string|null, "extractedEmail": string|null, "bookingReference": string|null, "description": string (always fill this in — 1 short plain-English sentence describing the image, used as a fallback if this isn't treated as a promo entry)}`;

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
      category: typeof parsed.category === "string" ? parsed.category : null,
      categoryDetail: typeof parsed.categoryDetail === "string" ? parsed.categoryDetail : null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      extractedName: typeof parsed.extractedName === "string" && parsed.extractedName.trim() ? parsed.extractedName.trim() : null,
      extractedEmail:
        typeof parsed.extractedEmail === "string" && parsed.extractedEmail.trim() ? parsed.extractedEmail.trim() : null,
      bookingReference:
        typeof parsed.bookingReference === "string" && parsed.bookingReference.trim() ? parsed.bookingReference.trim() : null,
      description: parsed.description.trim(),
    };
  } catch (err) {
    console.error("[Promo entry] Vision classification failed:", err);
    return undefined;
  }
}

interface SubmitterRow {
  id: string;
  whatsapp_phone: string;
  claimed_name: string | null;
  claimed_email: string | null;
}

async function upsertSubmitter(
  whatsappPhone: string,
  extractedName: string | null,
  extractedEmail: string | null
): Promise<SubmitterRow | undefined> {
  const supabase = getSupabase();
  if (!supabase) return undefined;

  const { data: existing, error: selectErr } = await supabase
    .from("submitters")
    .select("*")
    .eq("whatsapp_phone", whatsappPhone)
    .maybeSingle();
  if (selectErr) {
    console.error("[Promo entry] Failed to look up submitter:", selectErr);
    return undefined;
  }

  if (existing) {
    const patch: Partial<SubmitterRow> = {};
    if (!existing.claimed_name && extractedName) patch.claimed_name = extractedName;
    if (!existing.claimed_email && extractedEmail) patch.claimed_email = extractedEmail;
    if (Object.keys(patch).length === 0) return existing as SubmitterRow;

    const { data: updated, error: updateErr } = await supabase
      .from("submitters")
      .update(patch)
      .eq("id", existing.id)
      .select()
      .single();
    if (updateErr) {
      console.error("[Promo entry] Failed to update submitter:", updateErr);
      return existing as SubmitterRow;
    }
    return updated as SubmitterRow;
  }

  const { data: created, error: insertErr } = await supabase
    .from("submitters")
    .insert({ whatsapp_phone: whatsappPhone, claimed_name: extractedName, claimed_email: extractedEmail })
    .select()
    .single();
  if (insertErr) {
    console.error("[Promo entry] Failed to create submitter:", insertErr);
    return undefined;
  }
  return created as SubmitterRow;
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

export type PromoEntryResult =
  | {
      handled: true;
      category: PromoCategory;
      categoryDetail: string;
      needsIdentityFollowup: boolean;
      entryId: string;
    }
  | { handled: false; description?: string };

// Pulled out as its own pure function (no network calls) so the actual
// decision logic — is this a real, confident, valid-category entry? — can
// be unit-tested with synthetic classifier output, without needing a real
// vision call or Supabase project. Returns null for anything that should
// fall back to the normal image-description flow: not flagged as an entry,
// an unrecognized category (a model hallucination, or a schema drift
// between this code and the prompt), or below CONFIDENCE_THRESHOLD.
export function validateClassification(
  result: Pick<RawClassification, "isPromoEntry" | "category" | "categoryDetail" | "confidence">
): { category: PromoCategory; categoryDetail: string } | null {
  if (!result.isPromoEntry) return null;
  if (!result.category || !PROMO_CATEGORIES.includes(result.category as PromoCategory)) return null;
  if (result.confidence < CONFIDENCE_THRESHOLD) return null;

  const category = result.category as PromoCategory;
  const allowedDetails = VALID_DETAILS[category];
  const categoryDetail =
    allowedDetails && result.categoryDetail && allowedDetails.includes(result.categoryDetail)
      ? result.categoryDetail
      : "";
  return { category, categoryDetail };
}

// The single entry point server.ts calls for an inbound image while the
// promo is live. Downloads once, classifies once, and — only if it looks
// like a genuine entry above CONFIDENCE_THRESHOLD — persists it. Anything
// else (low confidence, not an entry, any step failing) returns
// `handled: false` with whatever description we do have, so the caller
// falls straight back to the normal "[Image the customer sent: ...]" flow
// with no special-casing needed on that side.
export async function processPromoScreenshot(
  whatsappPhone: string,
  mediaId: string,
  caption?: string
): Promise<PromoEntryResult> {
  const supabase = getSupabase();
  if (!supabase) return { handled: false };

  const downloaded = await downloadWhatsAppMedia(mediaId);
  if (!downloaded) return { handled: false };

  const result = await classify(downloaded.buffer, downloaded.mimeType, caption);
  if (!result) return { handled: false };

  const validated = validateClassification(result);
  if (!validated) return { handled: false, description: result.description };
  const { category, categoryDetail } = validated;

  const screenshotPath = await uploadScreenshot(downloaded.buffer, downloaded.mimeType, whatsappPhone);
  if (!screenshotPath) return { handled: false, description: result.description };

  const submitter = await upsertSubmitter(whatsappPhone, result.extractedName, result.extractedEmail);
  if (!submitter) return { handled: false, description: result.description };

  const { data: entry, error: insertErr } = await supabase
    .from("promo_entries")
    .insert({
      submitter_id: submitter.id,
      category,
      category_detail: categoryDetail,
      screenshot_path: screenshotPath,
      ai_suggested_category: category,
      ai_suggested_category_detail: categoryDetail,
      ai_confidence: result.confidence,
      ai_extracted_name: result.extractedName,
      ai_extracted_email: result.extractedEmail,
      ai_raw_response: result,
      booking_reference: result.bookingReference,
      status: "pending",
    })
    .select()
    .single();

  if (insertErr || !entry) {
    console.error("[Promo entry] Failed to log entry:", insertErr);
    return { handled: false, description: result.description };
  }

  console.log(`[Promo entry] Logged ${category}${categoryDetail ? `/${categoryDetail}` : ""} entry for ${whatsappPhone} (${entry.id})`);

  return {
    handled: true,
    category,
    categoryDetail,
    needsIdentityFollowup: !submitter.claimed_name && !submitter.claimed_email,
    entryId: entry.id,
  };
}

// Called when a customer replies to the bot's "what name/email did you
// sign up with?" follow-up (see server.ts's awaitingPromoIdentityFor
// check). Best-effort split: anything that looks like an email is pulled
// out, whatever's left is treated as the name — deliberately simple rather
// than trying to be clever, since an admin reviews every entry anyway and
// can make sense of a slightly messy reply either way.
export function parseIdentityReply(reply: string): { name?: string; email?: string } {
  const emailMatch = reply.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  const email = emailMatch ? emailMatch[0] : undefined;
  const name = reply
    .replace(email ?? "", "")
    .replace(/[,;]+/g, " ")
    .trim();
  return { name: name || undefined, email };
}

export async function recordPromoIdentityReply(whatsappPhone: string, entryId: string, reply: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;

  const { name, email } = parseIdentityReply(reply);

  const patch: Partial<Pick<SubmitterRow, "claimed_name" | "claimed_email">> = {};
  if (name) patch.claimed_name = name;
  if (email) patch.claimed_email = email;
  if (Object.keys(patch).length === 0) return;

  const { error: submitterErr } = await supabase.from("submitters").update(patch).eq("whatsapp_phone", whatsappPhone);
  if (submitterErr) console.error("[Promo entry] Failed to save identity reply on submitter:", submitterErr);

  const entryPatch: Record<string, string> = {};
  if (name) entryPatch.ai_extracted_name = name;
  if (email) entryPatch.ai_extracted_email = email;
  const { error: entryErr } = await supabase.from("promo_entries").update(entryPatch).eq("id", entryId);
  if (entryErr) console.error("[Promo entry] Failed to save identity reply on entry:", entryErr);
}

const CATEGORY_LABELS: Record<PromoCategory, string> = {
  signup: "signing up",
  profile_complete: "completing your profile",
  social_follow: "following us",
  content_post: "your #HustleAppTurns1 post",
  share: "sharing our anniversary post",
  like_comment: "engaging with our post",
  booking: "your completed booking",
};

export function buildPromoEntryConfirmation(result: Extract<PromoEntryResult, { handled: true }>): string {
  const label = CATEGORY_LABELS[result.category];
  const base = `Got it — logged your entry for ${label} in the Hustle @1 promo! 🎉 Our team will review it and confirm your points soon.`;
  if (!result.needsIdentityFollowup) return base;
  return `${base}\n\nOne thing — I couldn't quite make out your name/email on that screenshot. Could you reply with the name and email you registered as a Hustler with, so we can match this to your account? (Or reply "skip" and send it later.)`;
}
