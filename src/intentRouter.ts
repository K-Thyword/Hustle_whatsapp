import Anthropic from "@anthropic-ai/sdk";
import { BUSINESS_INFO } from "./businessInfo";

// Decides how to respond to a message that isn't yet mid-way through a
// structured booking step (i.e. the customer's opener, or an interruption
// while we're waiting on their booking mode). This is what lets the first
// message of a conversation feel like a person replying to what was
// actually said, instead of an unconditional scripted opener.
//
// This is intentionally decoupled from appApi.ts / the order flow — it
// only ever reads BUSINESS_INFO, never live provider/order data, so it
// works today even before the real backend endpoints exist.

export interface RoutedIntent {
  // "question": asking something about the business (possibly alongside a
  //   greeting, e.g. "Hi, are you guys open?") — reply answers it directly.
  // "booking_intent": clearly wants to book/request a service — reply is
  //   just a short acknowledgment; the app asks schedule/instant itself.
  // "greeting": a bare opener with no other content (hi, hello, morning...).
  // "other": anything else unclear.
  intent: "question" | "booking_intent" | "greeting" | "other";
  reply?: string;
}

// A light memory of this specific customer — past bookings they've
// submitted and a handful of their recent messages — so the AI doesn't
// treat every question as coming from a stranger with no history. Kept
// intentionally small; this is conversational context, not a database.
export interface ConversationContext {
  pastBookings: {
    requestId: string;
    mode: string;
    serviceType: string;
    location: string;
    dateWanted?: string;
    submittedAt: number;
  }[];
  recentMessages: string[];
}

const hasRealKey =
  process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== "from-console.anthropic.com";

const anthropic = hasRealKey ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

function buildSystemPrompt(context?: ConversationContext): string {
  let historySection = "";
  if (context && (context.pastBookings.length > 0 || context.recentMessages.length > 0)) {
    const bookingLines = context.pastBookings
      .map(
        (b) =>
          `- ${b.mode} booking, ${b.serviceType} in ${b.location}` +
          (b.dateWanted ? `, requested for ${b.dateWanted}` : "") +
          ` (reference ${b.requestId})`
      )
      .join("\n");
    const messageLines = context.recentMessages.slice(-10).join("\n");
    historySection = `

What you know about this specific customer (use this to avoid sounding like you've never spoken to them before — e.g. if they ask about "my last booking", refer to it by name/reference rather than asking "which booking?"):
${context.pastBookings.length > 0 ? `Past bookings:\n${bookingLines}` : "No past bookings yet."}
${context.recentMessages.length > 0 ? `\nRecent messages from them:\n${messageLines}` : ""}

We don't have live status tracking yet, so if they ask for a status update on a specific booking, acknowledge the booking by its details/reference and suggest saying "agent" so a human can check on it — don't invent a status.`;
  }

  return `You are the WhatsApp assistant for Hustleapp, a marketplace connecting customers with artisans and professional service providers (not sellers of physical goods) — things like plumbers, electricians, carpenters, mechanics, hairdressers, chefs, accountants, lawyers, tutors, homecare nurses, and similar trades common in Ghana.

Classify the customer's message into exactly one of these:
- "question": they're asking something specific — about the business (hours, pricing, policies, service areas, whether this is really Hustleapp, how something works, etc.) or about their own past bookings. This includes messages that open with a greeting but then ask something, e.g. "Hi, are you guys open?" or "hello, is this Hustleapp?" — those are "question", not "greeting".
- "booking_intent": they've clearly stated or strongly implied they want to book/request a service, e.g. "I need a plumber", "can I book a hairdresser", "I want to get something fixed".
- "greeting": a bare opener with nothing else to respond to — "hi", "hello", "good morning", "hey there", etc.
- "other": anything else unclear, small talk, or that doesn't fit above.

Then write a natural "reply" as a friendly, switched-on human support agent chatting on WhatsApp — never a corporate script, never a stale fixed line. Ground rules for the reply, depending on intent:

- "question": answer it directly and helpfully using ONLY the business info below (if it's a greeting+question combo like "Hi, are you open?", acknowledge the greeting warmly in the same breath as answering). If the info below doesn't cover it, say you're not sure and suggest they ask a human — never invent details. Do NOT ask whether they want this scheduled or done right away — that's handled separately.
- "booking_intent": reply should be ONLY a short, warm acknowledgment of what they need (e.g. "Sure, happy to help you find a plumber!") — do NOT ask about date/timing yourself, and do NOT ask them to reply 'schedule' or 'instant' — the app adds that question separately right after your reply.
- "greeting": a warm welcome plus an open question inviting them to say what they need help with today. Don't assume they want to book yet.
- "other": a brief, friendly line inviting them to clarify what they need help with.

Other style rules:
- Simple, everyday English. Short sentences. Correct grammar and spelling.
- Vary your wording naturally — don't reuse the exact same stock phrases every reply.
- Concise — a sentence or two is usually enough.
- Contractions are fine ("you'll", "it's") — sound like a person, not a policy document.
- Never address the customer by a name unless they've explicitly told you it's their own name in this conversation (e.g. "my name is Kwame"). A name that shows up in their messages for any other reason — mentioning someone else, thanking a person by name — is NOT their name. If you don't know their name, don't use one; "you"/"there" is fine.
- Many customers are Ghanaian and may greet you in Twi or Ga, e.g. "Maakye" (good morning), "Maaha" (good afternoon), "Maadwo" (good evening), "Ete sɛn" / "Wo ho te sɛn" (how are you), "Chale" (informal "hey friend"), "Ojekoo" (Ga good morning), or a mix with English/Pidgin like "eh" or "yoo" for yes/ok. Treat these exactly like an English greeting — respond warmly (English is fine, or a short matching greeting back), don't get confused or ask them to clarify. This is "greeting" intent, not "other".

Business info:
${BUSINESS_INFO}
${historySection}

Respond with strict JSON only, nothing else, no markdown formatting:
{"intent": "question" | "booking_intent" | "greeting" | "other", "reply": "string"}`;
}

export async function routeIntent(message: string, context?: ConversationContext): Promise<RoutedIntent> {
  // No API key configured yet — fall back to treating everything as
  // booking intent so the rest of the bot keeps working, just without the
  // natural greeting/FAQ handling until ANTHROPIC_API_KEY is set in .env.
  if (!anthropic) {
    return { intent: "booking_intent" };
  }

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: buildSystemPrompt(context),
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
    if (
      parsed.intent === "question" ||
      parsed.intent === "booking_intent" ||
      parsed.intent === "greeting" ||
      parsed.intent === "other"
    ) {
      return { intent: parsed.intent, reply: parsed.reply ?? undefined };
    }
    return { intent: "other" };
  } catch (err) {
    console.error("Intent routing failed, falling back to booking intent:", err);
    return { intent: "booking_intent" };
  }
}
