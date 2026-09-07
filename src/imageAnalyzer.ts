// Lets the bot actually look at images customers send — most usefully, a
// screenshot of a Hustleapp post they're asking about, but also works for
// a photo of the job they need done. The description is folded into the
// message text (see server.ts) so everything downstream — intent routing,
// the Posts-sheet matching in postLinkResolver.ts's caller, extraction —
// handles it exactly like typed text, the same "small bolt-on" approach
// voiceTranscriber.ts uses for speech.
//
// Trust note: the media ID always comes from an image WhatsApp says was
// actually sent to our bot, downloaded via whatsappMedia.ts's trusted,
// first-party Graph API path — never a customer-supplied URL — so this
// doesn't introduce the arbitrary-fetch (SSRF) surface postLinkResolver.ts
// is careful to avoid.
//
// IMPORTANT — this is NOT an authenticity check. Vision can describe what
// an image LOOKS like, but a screenshot can be doctored to look exactly
// like a real post; it has no way to confirm the image actually came from
// our Page/IG account. The description is only a hint for matching against
// verified posts (see postLinkResolver.ts / socialPostSync.ts) — never
// treat it as proof something is genuinely ours, and the prompt below is
// written to keep the model from speculating about authenticity itself.
//
// Requires ANTHROPIC_API_KEY (already used for intent routing — no new key
// needed). Gracefully returns undefined if the key isn't set, the
// WhatsApp media download fails, or the vision call fails — same
// conservative-fallback pattern used throughout this app.

import Anthropic from "@anthropic-ai/sdk";
import { downloadWhatsAppMedia } from "./whatsappMedia";

const hasRealKey =
  process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== "from-console.anthropic.com";
const anthropic = hasRealKey ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

type SupportedImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const SUPPORTED_MIME_TYPES: SupportedImageMime[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

function normalizeMimeType(mimeType: string): SupportedImageMime {
  return (SUPPORTED_MIME_TYPES as string[]).includes(mimeType) ? (mimeType as SupportedImageMime) : "image/jpeg";
}

export async function describeImage(mediaId: string, customerCaption?: string): Promise<string | undefined> {
  if (!anthropic) return undefined;

  const downloaded = await downloadWhatsAppMedia(mediaId);
  if (!downloaded) return undefined;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: normalizeMimeType(downloaded.mimeType),
                data: Buffer.from(downloaded.buffer).toString("base64"),
              },
            },
            {
              type: "text",
              text:
                "Describe what's in this image in 1-2 short sentences, plain English, as if relaying it to a " +
                "colleague who can't see it. If it looks like a screenshot of a social media post (Facebook or " +
                "Instagram), transcribe any visible caption/promo text word-for-word if legible, and note which " +
                "platform it looks like it's from. " +
                (customerCaption ? `The sender's own caption on this image was: "${customerCaption}". ` : "") +
                "Do not speculate about whether this is a genuine/official post or claim to verify anything — " +
                "just describe what is visibly there.",
            },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return undefined;
    const description = textBlock.text.trim();
    return description.length > 0 ? description : undefined;
  } catch (err) {
    console.error("[Image analyzer] Vision call failed:", err);
    return undefined;
  }
}
