import Anthropic from "@anthropic-ai/sdk";

// Best-effort extraction of booking specifics a customer may have already
// stated in a single free-text message — e.g. "I need a painter to paint
// my room, I'm in Ho, Volta Region" clearly states both the service and
// the location in one go. Used so the bot can confirm what it understood
// and skip re-asking for details already given, instead of walking
// through every question from scratch regardless of what's already been
// said — which previously produced exchanges like:
//   Bot: "What kind of service do you need?"
//   Customer: "I already mentioned"
//   Bot: [stores "I already mentioned" as the service type — wrong]
//
// Deliberately conservative: only returns a field when reasonably
// confident it's actually there. An empty/undefined field means "ask for
// it normally" — never guess or infer from vague wording.

export interface ExtractedBookingDetails {
  serviceType?: string; // short, as the customer would say it — e.g. "painter"
  location?: string; // e.g. "Ho, Volta Region"
}

const hasRealKey =
  process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== "from-console.anthropic.com";
const anthropic = hasRealKey ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const SYSTEM_PROMPT = `Extract booking details a customer already stated when asking for a service, on a marketplace connecting customers with artisans/professionals (plumbers, electricians, painters, caterers, cleaners, tutors, accountants, and similar trades — not physical goods).

Only fill in a field if it is clearly and explicitly stated in the message — never guess, infer, or pad from vague wording. If something isn't clearly there, omit it.

Respond with strict JSON only, nothing else, no markdown formatting:
{"serviceType": "string, omit if not stated", "location": "string, omit if not stated"}

Examples:
"I need a painter to paint my room, I am in Ho, Volta Region, can I get anyone?" -> {"serviceType": "painter", "location": "Ho, Volta Region"}
"can I book a hairdresser" -> {"serviceType": "hairdresser"}
"I need a plumber in Accra" -> {"serviceType": "plumber", "location": "Accra"}
"is this Hustleapp" -> {}
"hi, are you guys open" -> {}`;

export async function extractBookingDetails(message: string): Promise<ExtractedBookingDetails> {
  if (!anthropic) return {};

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: message }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return {};

    const cleaned = textBlock.text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();

    const parsed = JSON.parse(cleaned);
    const result: ExtractedBookingDetails = {};
    if (typeof parsed.serviceType === "string" && parsed.serviceType.trim()) {
      result.serviceType = parsed.serviceType.trim();
    }
    if (typeof parsed.location === "string" && parsed.location.trim()) {
      result.location = parsed.location.trim();
    }
    return result;
  } catch (err) {
    console.error("Booking detail extraction failed, falling back to asking normally:", err);
    return {};
  }
}
