import Anthropic from "@anthropic-ai/sdk";

// Two jobs in one, because they're really the same underlying question
// ("what does this customer actually need?"):
//
// 1. Natural-language mapping — a customer often describes a PROBLEM, not a
//    trade ("my AC isn't cooling" rather than "AC repair"). This maps that
//    to a short, normal service label so it reads correctly in the booking
//    summary, matches serviceCategories.ts's keyword lookup, and doesn't
//    show an agent a raw symptom sentence where a service name belongs.
// 2. Scope check — Hustleapp's policy (see businessInfo.ts) is permissive
//    by design: real trades, even unusual or less-common ones, should
//    still be taken and handed to an agent to try to source, since there's
//    no live provider catalog to check against. This only draws the line
//    at requests that plainly aren't a real professional/artisan service
//    at all — fictional, nonsensical, illegal/harmful, or actually a
//    request for physical goods rather than a service.
//
// Deliberately biased toward accepting: if a request is a genuine (if
// niche) trade, or the model is simply unsure, this should say "supported"
// and let a human agent be the one to say "sorry, couldn't find anyone" —
// that's a better failure mode than the bot wrongly turning away a real
// customer. Declining is reserved for the clear-cut cases.

export interface ResolvedService {
  supported: boolean;
  serviceType?: string; // canonical short label, only set when supported
  suggestion?: string; // 1-2 related real services to offer instead, when not supported (omitted if no sensible bridge, e.g. harmful requests)
}

const hasRealKey =
  process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== "from-console.anthropic.com";
const anthropic = hasRealKey ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const SYSTEM_PROMPT = `You classify what a customer wants on Hustleapp, a Ghanaian marketplace connecting customers with artisans/professionals ("Hustlers") for hire — plumbers, electricians, carpenters, mechanics, hairdressers, chefs/caterers, cleaners, accountants, tutors, homecare nurses, photographers, event planners, and any similar trade or professional service commonly found in the Ghanaian economy. It does NOT sell or deliver physical goods.

The service list is a guide, not a strict limit — real trades should be accepted even if unusual, niche, or not explicitly named above, since a human agent manually tries to source someone for every request. Only mark something unsupported if it is clearly NOT a real professional/artisan service: fictional or absurd requests, illegal or harmful requests, or a request to buy/receive physical goods rather than hire someone's labor/expertise. When genuinely unsure, treat it as supported — a human agent following up and not finding anyone is a much better outcome than wrongly turning away a real customer.

The customer's message may describe a PROBLEM rather than name a trade directly (e.g. "my AC isn't cooling", "my sink is leaking", "my laptop won't turn on") — in that case, infer the short, normal service name a Ghanaian customer would use for whoever fixes that problem (e.g. "AC repair", "plumber", "computer repair technician").

Respond with strict JSON only, nothing else, no markdown formatting:
{"supported": true, "serviceType": "short normal service name"}
or
{"supported": false, "suggestion": "1-2 related real services, or omit this field entirely if there's no sensible related suggestion"}

Examples:
"I need a plumber" -> {"supported": true, "serviceType": "plumber"}
"my AC isn't cooling" -> {"supported": true, "serviceType": "AC repair"}
"can I get an upholsterer" -> {"supported": true, "serviceType": "upholsterer"}
"someone to walk my dog" -> {"supported": true, "serviceType": "dog walker"}
"I need a helicopter mechanic" -> {"supported": false, "suggestion": "an auto mechanic or an electrician"}
"I want to buy a fridge" -> {"supported": false, "suggestion": "we only connect you with service providers, not sellers of goods"}
"I need a wizard to remove a curse" -> {"supported": false}
"I need someone to hurt my neighbor" -> {"supported": false}`;

export async function resolveServiceType(text: string): Promise<ResolvedService> {
  const trimmed = text.trim();
  if (!trimmed) return { supported: true, serviceType: trimmed };

  // No key configured, or something goes wrong — fail open. Accepting an
  // unusual request as typed and letting an agent sort it out is a much
  // safer default than blocking a real customer over an API hiccup.
  if (!anthropic) return { supported: true, serviceType: trimmed };

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: trimmed }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") return { supported: true, serviceType: trimmed };

    const cleaned = textBlock.text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();

    const parsed = JSON.parse(cleaned);
    if (parsed.supported === false) {
      const suggestion = typeof parsed.suggestion === "string" && parsed.suggestion.trim() ? parsed.suggestion.trim() : undefined;
      return { supported: false, suggestion };
    }

    const serviceType =
      typeof parsed.serviceType === "string" && parsed.serviceType.trim() ? parsed.serviceType.trim() : trimmed;
    return { supported: true, serviceType };
  } catch (err) {
    console.error("Service resolution failed, accepting as typed:", err);
    return { supported: true, serviceType: trimmed };
  }
}
