// Tracks WhatsApp's 24-hour customer service window on a per-agent basis,
// and queues content that couldn't go out as a free-form message so it can
// be delivered the moment the window reopens.
//
// WhatsApp's rule: a business can only send free-form ("session") messages
// to a number within 24 hours of that number's last message TO the
// business. Outside that window, only a pre-approved message template can
// be sent. This applies to every number the business messages — including
// our own agent numbers, not just customers. Without this, an automated
// notification (new booking, unclaimed-request nudge, etc.) sent to an
// agent who hasn't texted the bot recently would silently fail against
// the real API.
//
// This module is the seam that hides all of that: callers just call
// notifyAgentSmart() (see server.ts) and don't need to know whether the
// window is open — this module tracks it, and server.ts's sendTemplateMessage
// handles the outside-the-window case.
//
// Photos/videos/documents forwarded to agents ride the same queue as text.
// There's no separate media template for these (WhatsApp media template
// headers need their own per-type template setup, which isn't worth the
// extra Meta approvals here) — instead, a queued attachment just waits
// alongside any queued text and gets sent as a normal free-form media
// message the moment the agent's window reopens. The accompanying text
// notification already went out via a template, so the agent is prompted
// to reply either way; the attachment simply arrives right after.
//
// In-memory, same as sessions.ts/quotes.ts — resets on redeploy, which is
// an acceptable interim limitation consistent with the rest of this app.

import type { MediaAttachment } from "./server";

const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

// The most recent time we received a message FROM each agent number.
const lastInboundAt = new Map<string, number>();

export type PendingAgentItem =
  | { type: "text"; message: string }
  | { type: "media"; attachment: MediaAttachment };

// Content that couldn't be delivered as a free-form message because the
// window was closed — held here until the agent's next reply reopens it.
// Capped per agent so an agent who never replies doesn't accumulate an
// unbounded backlog.
const PENDING_LIMIT_PER_AGENT = 20;
const pendingByAgent = new Map<string, PendingAgentItem[]>();

export function recordAgentInbound(agentPhone: string): void {
  lastInboundAt.set(agentPhone, Date.now());
}

export function isAgentWindowOpen(agentPhone: string): boolean {
  const last = lastInboundAt.get(agentPhone);
  if (!last) return false; // never heard from them — treat as closed
  return Date.now() - last < WHATSAPP_WINDOW_MS;
}

function queuePendingAgentItem(agentPhone: string, item: PendingAgentItem): void {
  const existing = pendingByAgent.get(agentPhone) ?? [];
  pendingByAgent.set(agentPhone, [...existing, item].slice(-PENDING_LIMIT_PER_AGENT));
}

export function queuePendingAgentMessage(agentPhone: string, message: string): void {
  queuePendingAgentItem(agentPhone, { type: "text", message });
}

export function queuePendingAgentMedia(agentPhone: string, attachment: MediaAttachment): void {
  queuePendingAgentItem(agentPhone, { type: "media", attachment });
}

// Removes and returns everything queued for this agent — call once the
// window is confirmed open (i.e. right after recording an inbound message
// from them) so the real content can go out as normal free-form messages.
export function drainPendingAgentItems(agentPhone: string): PendingAgentItem[] {
  const existing = pendingByAgent.get(agentPhone) ?? [];
  pendingByAgent.delete(agentPhone);
  return existing;
}
