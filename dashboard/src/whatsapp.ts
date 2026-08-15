// Minimal, purpose-built WhatsApp sender for this service's one job: the
// weekly digest broadcast to agents. Deliberately NOT a general messaging
// module (the bot already has one, far more capable) — this only ever
// sends ONE pre-approved template, which is what lets it work reliably
// regardless of whether an agent's 24h conversation window happens to be
// open at the time. A plain text message would silently fail on a Monday
// morning if nobody's messaged the bot over the weekend; a template
// message works unconditionally, which is the entire point of templates.
//
// Uses its own copy of the Meta credentials (set directly on THIS
// service's Railway variables, not shared at runtime with the bot)
// rather than calling back into the bot service — keeps this service
// fully independent, so a dashboard-side bug or outage can never affect
// the live customer-facing bot, and vice versa.
//
// Requires a template to exist in Meta Business Manager first:
//   Name: hustle_weekly_digest (or set WEEKLY_DIGEST_TEMPLATE_NAME)
//   Category: Utility
//   Body: one variable, e.g. "Hustleapp weekly summary: {{1}}"
//   Language: must exactly match WEEKLY_DIGEST_TEMPLATE_LANGUAGE below
//     (default en_US — pick "English (US)" specifically when creating it,
//     not just "English", which is a different language code and will
//     fail with error 132001 otherwise — see the bot's own README for the
//     exact same gotcha hit there).
// Until that template exists and is approved, sends just log a dry-run
// line instead of failing loudly.

const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const TEMPLATE_NAME = process.env.WEEKLY_DIGEST_TEMPLATE_NAME || "hustle_weekly_digest";
const TEMPLATE_LANGUAGE = process.env.WEEKLY_DIGEST_TEMPLATE_LANGUAGE || "en_US";

const AGENT_NUMBERS = (process.env.AGENT_NOTIFY_NUMBERS || "")
  .split(",")
  .map((n) => n.trim())
  .filter(Boolean);

export function whatsappConfigured(): boolean {
  return Boolean(ACCESS_TOKEN && PHONE_NUMBER_ID && AGENT_NUMBERS.length > 0);
}

// WhatsApp template body params can't contain newlines and have a length
// limit — flattened and trimmed defensively rather than letting a long
// AI-written digest fail the send outright over formatting.
function sanitizeForTemplate(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 1000);
}

async function sendTemplate(to: string, bodyParam: string): Promise<boolean> {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: TEMPLATE_NAME,
          language: { code: TEMPLATE_LANGUAGE },
          components: [{ type: "body", parameters: [{ type: "text", text: bodyParam }] }],
        },
      }),
    });
    if (!res.ok) {
      console.error(`Failed to send weekly digest template to ${to}:`, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Failed to send weekly digest template to ${to}:`, err);
    return false;
  }
}

export async function sendDigestToAgents(text: string): Promise<{ sent: number; failed: number }> {
  if (!whatsappConfigured()) {
    console.log("[Weekly digest DRY RUN — WhatsApp not configured on the dashboard service]:\n", text);
    return { sent: 0, failed: 0 };
  }
  const param = sanitizeForTemplate(text);
  let sent = 0;
  let failed = 0;
  for (const number of AGENT_NUMBERS) {
    const ok = await sendTemplate(number, param);
    if (ok) sent += 1;
    else failed += 1;
  }
  return { sent, failed };
}
