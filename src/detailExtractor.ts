import Anthropic from "@anthropic-ai/sdk";

// Extracts whatever booking details are newly present in ONE customer
// message, given what's already known. This is the core of the
// conversational (not step-by-step) booking flow: a customer can give
// several fields in one message, in any order, at any point in the
// conversation — this picks up whatever's actually there instead of only
// accepting an answer to the one specific question the bot happens to be
// mid-way through asking. See server.ts's "collecting_booking" stage for
// the caller — it merges whatever this returns into the session, then asks
// (with a fixed, testable checklist — see getMissingBookingField) for
// whatever's still missing, in whatever order the customer hasn't already
// covered.
//
// Deliberately conservative: only returns a field when clearly stated.
// Never guess or infer from vague wording — an omitted field just means
// "still don't have it," which the checklist logic asks for normally. This
// matters even more here than in a single-shot extractor, since it runs on
// EVERY message in the flow: a false-positive extraction would silently
// misfile something (e.g. reading part of a description as the location)
// with no confirmation step to catch it.

export interface ExtractedSlots {
  serviceType?: string; // short, as the customer would say it — e.g. "painter"
  location?: string; // e.g. "Ho, Volta Region"
  timingPhrase?: string; // the timing reference AS STATED — a date ("Friday", "next Monday") OR asap/no-preference phrasing ("whenever works", "no rush") — not computed/classified here, see dateInterpreter.ts and NO_PREFERENCE_PHRASES in server.ts
  description?: string; // what the job actually is/what's needed
  specialInstructions?: string; // only if volunteered unprompted — access notes, timing preferences, things to be careful of
  recurring?: string; // only if volunteered unprompted — "one-time" or "regular"-ish
  budget?: string; // only if volunteered unprompted — a rough amount or range
}

const hasRealKey =
  process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== "from-console.anthropic.com";
const anthropic = hasRealKey ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

function buildSystemPrompt(alreadyKnown: Partial<ExtractedSlots>): string {
  const knownLines = (Object.entries(alreadyKnown) as [keyof ExtractedSlots, string | undefined][])
    .filter(([, v]) => Boolean(v))
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  return `Extract booking details a customer states, on a marketplace connecting customers with artisans/professionals (plumbers, electricians, painters, caterers, cleaners, tutors, accountants, and similar trades — not physical goods). This runs on every message in an ongoing conversation, not just the first one, so the customer may be answering a specific question, volunteering something unprompted, or both at once.

Only fill in a field if it is clearly and explicitly stated in THIS message — never guess, infer, or pad from vague wording, and never repeat something already known unless the customer is correcting it. If something isn't clearly there, omit it.

${knownLines ? `Already known about this booking (do not re-extract these unless the customer is clearly changing one):\n${knownLines}\n` : ""}
Respond with strict JSON only, nothing else, no markdown formatting:
{"serviceType": "string, omit if not stated", "location": "string, omit if not stated", "timingPhrase": "string, omit if not stated", "description": "string, omit if not stated", "specialInstructions": "string, omit if not stated", "recurring": "string, omit if not stated", "budget": "string, omit if not stated"}

timingPhrase: copy the timing reference exactly as the customer wrote it — either a date reference ("Friday", "next Monday", "the 20th", "tomorrow") OR asap/no-preference phrasing ("as soon as possible", "whenever works", "no rush", "anytime", "no specific date"). Do NOT compute or classify it yourself, that happens separately. Extract this even when it's just one clause in a longer sentence about something else.

description: what the job/problem actually is — e.g. "leaking pipe under the kitchen sink", "need my 2-bedroom apartment deep cleaned". Only extract this if the customer is describing the actual work needed, not just naming a trade (naming a trade alone is serviceType, not description).

specialInstructions: only extract if the customer volunteers something like an access note, a preference for who does the job, or something to be careful of, WITHOUT being directly asked "anything else we should know" — e.g. "please call before coming" or "the gate code is 1234". Do not extract a bare "no"/"nothing" as special instructions.

recurring / budget: only extract if the customer volunteers this unprompted (e.g. "I'll need this every week" or "my budget is around 200 cedis") — do not infer these.

Examples:
"I need a painter to paint my room, I am in Ho, Volta Region" -> {"serviceType": "painter", "location": "Ho, Volta Region"}
"can I book a hairdresser" -> {"serviceType": "hairdresser"}
"my sink is leaking, I'm in Accra, need it done today" -> {"serviceType": "plumber", "location": "Accra", "timingPhrase": "today", "description": "leaking sink"}
"whenever works, no rush" -> {"timingPhrase": "whenever works, no rush"}
"is this Hustleapp" -> {}
"hi, are you guys open" -> {}
"ok" -> {}
"call me before you arrive please, gate code is 4521" -> {"specialInstructions": "call before arriving, gate code is 4521"}`;
}

export async function extractBookingSlots(
  message: string,
  alreadyKnown: Partial<ExtractedSlots> = {}
): Promise<ExtractedSlots> {
  if (!anthropic || !message.trim()) return {};

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: buildSystemPrompt(alreadyKnown),
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
    const result: ExtractedSlots = {};
    const fields: (keyof ExtractedSlots)[] = [
      "serviceType",
      "location",
      "timingPhrase",
      "description",
      "specialInstructions",
      "recurring",
      "budget",
    ];
    for (const field of fields) {
      const value = parsed[field];
      if (typeof value === "string" && value.trim()) {
        result[field] = value.trim();
      }
    }
    return result;
  } catch (err) {
    console.error("Booking slot extraction failed, falling back to asking normally:", err);
    return {};
  }
}
