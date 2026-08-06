// Turns whatever a customer types for a booking date — "tomorrow", "5th
// agust" (typo and all), "next Monday", "15/08" — into a specific calendar
// date, using the AI to handle typos and ambiguity that a plain date
// parser would miss. Never used to silently accept a guess: the caller is
// expected to read back the interpretation and get explicit confirmation
// before treating it as final.

import Anthropic from "@anthropic-ai/sdk";
import * as chrono from "chrono-node";

export interface DateInterpretation {
  status: "valid" | "past" | "unclear";
  isoDate?: string; // YYYY-MM-DD
  humanReadable?: string; // e.g. "Tuesday, 5 August 2026"
}

const hasRealKey =
  process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== "from-console.anthropic.com";

const anthropic = hasRealKey ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

function isPast(date: Date, referenceDate: Date): boolean {
  const today = new Date(referenceDate);
  today.setHours(0, 0, 0, 0);
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  return day.getTime() < today.getTime();
}

// No Anthropic key configured — fall back to chrono-node alone. It won't
// catch typos, but it's far better than accepting anything unvalidated.
function interpretWithChronoOnly(text: string, referenceDate: Date): DateInterpretation {
  const parsed = chrono.parseDate(text, referenceDate);
  if (!parsed) return { status: "unclear" };
  if (isPast(parsed, referenceDate)) {
    return { status: "past", isoDate: parsed.toISOString().slice(0, 10), humanReadable: parsed.toDateString() };
  }
  return { status: "valid", isoDate: parsed.toISOString().slice(0, 10), humanReadable: parsed.toDateString() };
}

export async function interpretDate(text: string, referenceDate: Date): Promise<DateInterpretation> {
  if (!anthropic) {
    return interpretWithChronoOnly(text, referenceDate);
  }

  const system = `Today's date is ${referenceDate.toDateString()}. A customer is telling you, in free text, what date they want a service booked for. It may be relative ("tomorrow", "next Friday"), absolute, or contain typos or unusual spelling (e.g. "agust" for "August", "tues" for "Tuesday").

Interpret it as one specific calendar date. Respond with strict JSON only, nothing else, no markdown formatting:
{"status": "valid" | "past" | "unclear", "isoDate": "YYYY-MM-DD" or null, "humanReadable": "e.g. Tuesday, 5 August 2026" or null}

- "valid": you're reasonably confident of the date, and it's today or later.
- "past": you're reasonably confident of the date, but it's already before today.
- "unclear": the text doesn't give you enough to confidently determine a date at all.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system,
      messages: [{ role: "user", content: text }],
    });

    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return { status: "unclear" };

    const cleaned = block.text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();

    const parsed = JSON.parse(cleaned);
    if (parsed.status === "valid" || parsed.status === "past" || parsed.status === "unclear") {
      return {
        status: parsed.status,
        isoDate: parsed.isoDate ?? undefined,
        humanReadable: parsed.humanReadable ?? undefined,
      };
    }
    return { status: "unclear" };
  } catch (err) {
    console.error("Date interpretation failed, falling back to chrono-node:", err);
    return interpretWithChronoOnly(text, referenceDate);
  }
}
