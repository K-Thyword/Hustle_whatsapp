// A written weekly summary of what happened — the same content that's
// planned to also go out over WhatsApp (see the bot's README, "Visibility"
// section), but viewable here on demand instead of waiting for the once-
// a-week message, plus a history of past ones. Falls back to a plain
// computed summary (no AI) if no Anthropic key is configured, so the
// Reports tab always shows something real rather than an error.

import Anthropic from "@anthropic-ai/sdk";
import { getRequests, getAlerts, getAgentStats, RequestSummary } from "./sheetsData";

// .trim() matters here: a key pasted into Railway's variable field with a
// trailing newline or space (easy to do when copying a whole line from a
// terminal or text file) passes this "is it configured" check fine, but
// then makes Anthropic's client throw "is not a legal HTTP header value"
// on every request, since raw newlines aren't allowed in HTTP headers —
// confirmed live: the key looked right, was genuinely present, and still
// failed until trimmed.
const rawKey = process.env.ANTHROPIC_API_KEY?.trim();
const hasRealKey = Boolean(rawKey) && rawKey !== "from-console.anthropic.com";
const anthropic = hasRealKey ? new Anthropic({ apiKey: rawKey }) : null;

function computedSummary(requests: RequestSummary[], sinceIso: string, alertCount: number): string {
  const inWindow = requests.filter((r) => r.submittedAt >= sinceIso);
  const completed = inWindow.filter((r) => r.status === "completed" || r.status === "reviewed").length;
  const cancelled = inWindow.filter((r) => r.status === "cancelled").length;
  const stillOpen = inWindow.filter((r) => r.isOpen).length;
  const byService = new Map<string, number>();
  for (const r of inWindow) byService.set(r.serviceType, (byService.get(r.serviceType) ?? 0) + 1);
  const topServices = Array.from(byService.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([s, n]) => `${s} (${n})`)
    .join(", ");

  return (
    `This week: ${inWindow.length} new requests, ${completed} completed, ${cancelled} cancelled, ${stillOpen} still open.` +
    (topServices ? ` Most requested: ${topServices}.` : "") +
    (alertCount > 0 ? ` ${alertCount} delivery alert${alertCount === 1 ? "" : "s"} logged — worth a look.` : " No delivery alerts this week.")
  );
}

export async function generateWeeklyDigest(): Promise<{ text: string; aiGenerated: boolean }> {
  const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [requests, alerts, agentStats] = await Promise.all([getRequests(), getAlerts(), getAgentStats()]);
  const alertsInWindow = alerts.filter((a) => a.timestamp >= sinceIso);

  if (!anthropic) {
    return { text: computedSummary(requests, sinceIso, alertsInWindow.length), aiGenerated: false };
  }

  const inWindow = requests.filter((r) => r.submittedAt >= sinceIso);
  const dataBlock = JSON.stringify(
    {
      requestsThisWeek: inWindow.map((r) => ({
        service: r.serviceType,
        location: r.location,
        status: r.status,
        claimedBy: r.claimedByName,
      })),
      alertsThisWeek: alertsInWindow.map((a) => a.message),
      agentWorkload: agentStats.map((a) => ({ name: a.name, claimed: a.claimed, open: a.open, completed: a.completed })),
    },
    null,
    2
  );

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system:
        "You write a short, plain-English weekly ops summary for Hustleapp, a WhatsApp-based marketplace connecting customers with artisans/professionals in Ghana. Given raw data about this week's booking requests, delivery alerts, and agent workload, write 3-5 sentences a busy owner could read in ten seconds: overall volume, anything that stands out (a spike, a service in high demand, an agent overloaded, unresolved alerts), and one practical suggestion if something needs attention. No headers, no bullet points, no markdown — plain sentences. Don't invent numbers not in the data.",
      messages: [{ role: "user", content: dataBlock }],
    });
    const block = response.content.find((b) => b.type === "text");
    const text = block && block.type === "text" ? block.text.trim() : null;
    if (!text) throw new Error("empty response");
    return { text, aiGenerated: true };
  } catch (err) {
    console.error("AI weekly digest failed, falling back to computed summary:", err);
    return { text: computedSummary(requests, sinceIso, alertsInWindow.length), aiGenerated: false };
  }
}
