import Anthropic from "@anthropic-ai/sdk";

// Detects whether a customer's message is asking to be reminded about
// something later ("remind me to book a hairdresser next week"), and pulls
// out what to remind them about plus (if given) a raw when-phrase — kept
// raw rather than parsed here, since dateInterpreter.ts already does date
// parsing with typo tolerance and this shouldn't duplicate that logic.
//
// Deliberately conservative, same pattern as detailExtractor.ts and
// serviceResolver.ts: only returns isReminderRequest true when the message
// is clearly asking for a reminder AND states what it's about. If either
// is missing or ambiguous, this says false and the message is handled as
// a normal message instead of guessing.

export interface ExtractedReminder {
  isReminderRequest: boolean;
  text?: string; // short, clear description of what to remind them about
  whenText?: string; // raw phrase for when, e.g. "next week" — omitted if not given
}

const hasRealKey =
  process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== "from-console.anthropic.com";
const anthropic = hasRealKey ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const SYSTEM_PROMPT = `A customer messaging Hustleapp (a Ghanaian marketplace connecting customers with artisans/professionals for hire) may ask to be reminded about something later — e.g. "remind me to book a hairdresser next week", "can you remind me about my plumber appointment tomorrow", "set a reminder for next Friday to sort out my AC".

Decide if this message is asking to set a reminder. If it is, extract:
- text: a short, clear description of what they want to be reminded about, in their own words
- whenText: the raw phrase describing when, exactly as implied by the message (e.g. "next week", "tomorrow", "next Friday") — omit entirely if no time was mentioned at all

Only say true if the message is clearly asking to be reminded about something specific. General questions, complaints, or booking requests without "remind" language are false.

Respond with strict JSON only, nothing else, no markdown formatting:
{"isReminderRequest": true|false, "text": "string, omit if not a reminder request", "whenText": "string, omit if no time given"}

Examples:
"remind me to book for my hair appointment next week" -> {"isReminderRequest": true, "text": "book a hair appointment", "whenText": "next week"}
"can you remind me tomorrow to call the plumber" -> {"isReminderRequest": true, "text": "call the plumber", "whenText": "tomorrow"}
"remind me to sort out my AC" -> {"isReminderRequest": true, "text": "sort out my AC"}
"I need a plumber" -> {"isReminderRequest": false}
"what time do you close" -> {"isReminderRequest": false}
"did you get my reminder" -> {"isReminderRequest": false}`;

export async function extractReminderRequest(message: string): Promise<ExtractedReminder> {
  if (!anthropic) return { isReminderRequest: false };

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: message }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return { isReminderRequest: false };

    const cleaned = textBlock.text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();

    const parsed = JSON.parse(cleaned);
    if (parsed.isReminderRequest !== true) return { isReminderRequest: false };

    const text = typeof parsed.text === "string" && parsed.text.trim() ? parsed.text.trim() : undefined;
    if (!text) return { isReminderRequest: false }; // nothing to actually remind them about

    const whenText =
      typeof parsed.whenText === "string" && parsed.whenText.trim() ? parsed.whenText.trim() : undefined;
    return { isReminderRequest: true, text, whenText };
  } catch (err) {
    console.error("Reminder extraction failed, treating as a normal message:", err);
    return { isReminderRequest: false };
  }
}
