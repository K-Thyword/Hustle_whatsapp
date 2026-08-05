import Anthropic from "@anthropic-ai/sdk";
import { BUSINESS_INFO } from "./businessInfo";

// Decides whether an inbound message is an order request or a general
// question about the business, and answers the question directly if so.
// This is intentionally decoupled from appApi.ts / the order flow — it
// only ever reads BUSINESS_INFO, never live provider/order data, so it
// works today even before the real backend endpoints exist.

export interface RoutedIntent {
  intent: "order" | "question" | "other";
  reply?: string;
}

const hasRealKey =
  process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== "from-console.anthropic.com";

const anthropic = hasRealKey ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const SYSTEM_PROMPT = `You are a WhatsApp assistant for Hustleapp, a marketplace connecting customers with artisans and professionals (plumbers, electricians, carpenters, accountants, lawyers, tutors, homecare nurses, etc.).

Decide whether the customer's message is:
- "order": they want to place an order, request a delivery/ride, or are continuing an order already in progress
- "question": they're asking something about the business (hours, pricing, policies, service areas, how something works, etc.)
- "other": a greeting, small talk, or anything unclear

If the intent is "question", answer it directly and helpfully using ONLY the business info below.
If the info below doesn't cover it, say you're not sure and suggest they ask a human — never invent details.

Business info:
${BUSINESS_INFO}

Respond with strict JSON only, nothing else, no markdown formatting:
{"intent": "order" | "question" | "other", "reply": "string, or null if intent is not question"}`;

export async function routeIntent(message: string): Promise<RoutedIntent> {
  // No API key configured yet — fall back to treating everything as an
  // order so the rest of the bot keeps working. Question-answering just
  // isn't smart until ANTHROPIC_API_KEY is set in .env.
  if (!anthropic) {
    return { intent: "order" };
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: message }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return { intent: "other" };
    }

    // Claude sometimes wraps JSON in a markdown code fence (```json ... ```)
    // despite being told not to — strip that before parsing.
    const cleaned = textBlock.text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();

    const parsed = JSON.parse(cleaned);
    if (parsed.intent === "order" || parsed.intent === "question" || parsed.intent === "other") {
      return { intent: parsed.intent, reply: parsed.reply ?? undefined };
    }
    return { intent: "other" };
  } catch (err) {
    console.error("Intent routing failed, falling back to order flow:", err);
    return { intent: "order" };
  }
}
