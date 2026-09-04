import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const referenceDate = new Date("2026-08-15T12:00:00Z");
const text = "i want a plumber at my usual place on Friday.";

const system = `Today's date is ${referenceDate.toDateString()}. A customer is telling you, in free text, what date they want a service booked for. It may be relative ("tomorrow", "next Friday"), absolute, or contain typos or unusual spelling (e.g. "agust" for "August", "tues" for "Tuesday").

Interpret it as one specific calendar date. Respond with strict JSON only, nothing else, no markdown formatting:
{"status": "valid" | "past" | "unclear", "isoDate": "YYYY-MM-DD" or null, "humanReadable": "e.g. Tuesday, 5 August 2026" or null}

- "valid": you're reasonably confident of the date, and it's today or later.
- "past": you're reasonably confident of the date, but it's already before today.
- "unclear": the text doesn't give you enough to confidently determine a date at all.`;

const response = await anthropic.messages.create({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 200,
  system,
  messages: [{ role: "user", content: text }],
});

const block = response.content.find((b) => b.type === "text");
console.log("RAW RESPONSE:", block?.text);
