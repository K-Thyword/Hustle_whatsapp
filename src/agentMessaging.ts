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
// Backed by store.ts (Redis, with an automatic in-memory fallback) so a
// crash or redeploy doesn't wipe window state or a queued notification.

import { kvGet, kvSet, kvDelete } from "./store";
import type { MediaAttachment } from "./server";

const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

const LAST_INBOUND_KEY_PREFIX = "agent-last-inbound:";
const PENDING_KEY_PREFIX = "agent-pending:";

export type PendingAgentItem =
  | { type: "text"; message: string }
  | { type: "media"; attachment: MediaAttachment };

// Content that couldn't be delivered as a free-form message because the
// window was closed — held here until the agent's next reply reopens it.
// Capped per agent so an agent who never replies doesn't accumulate an
// unbounded backlog.
const PENDING_LIMIT_PER_AGENT = 20;

export async function recordAgentInbound(agentPhone: string): Promise<void> {
  await kvSet(`${LAST_INBOUND_KEY_PREFIX}${agentPhone}`, Date.now());
}

export async function isAgentWindowOpen(agentPhone: string): Promise<boolean> {
  const last = await kvGet<number>(`${LAST_INBOUND_KEY_PREFIX}${agentPhone}`);
  if (!last) return false; // never heard from them — treat as closed
  return Date.now() - last < WHATSAPP_WINDOW_MS;
}

async function queuePendingAgentItem(agentPhone: string, item: PendingAgentItem): Promise<void> {
  const key = `${PENDING_KEY_PREFIX}${agentPhone}`;
  const existing = (await kvGet<PendingAgentItem[]>(key)) ?? [];
  await kvSet(key, [...existing, item].slice(-PENDING_LIMIT_PER_AGENT));
}

export async function queuePendingAgentMessage(agentPhone: string, message: string): Promise<void> {
  await queuePendingAgentItem(agentPhone, { type: "text", message });
}

export async function queuePendingAgentMedia(agentPhone: string, attachment: MediaAttachment): Promise<void> {
  await queuePendingAgentItem(agentPhone, { type: "media", attachment });
}

// Removes and returns everything queued for this agent — call once the
// window is confirmed open (i.e. right after recording an inbound message
// from them) so the real content can go out as normal free-form messages.
export async function drainPendingAgentItems(agentPhone: string): Promise<PendingAgentItem[]> {
  const key = `${PENDING_KEY_PREFIX}${agentPhone}`;
  const existing = (await kvGet<PendingAgentItem[]>(key)) ?? [];
  await kvDelete(key);
  return existing;
}
