// Queues content an agent sent to a customer that couldn't go out as a
// free-form message because WhatsApp's 24-hour customer service window was
// closed, so it can be delivered the moment the customer's next message
// reopens it — mirrors agentMessaging.ts's queue mechanics on the other
// side of the conversation (agent -> customer instead of bot -> agent).
//
// Window state itself is deliberately NOT tracked separately here the way
// agentMessaging.ts tracks it for agents: session.ts's
// lastCustomerMessageAt is already updated on every inbound customer
// message, so isCustomerWindowOpen just reads that instead of keeping a
// second, parallel "when did we last hear from them" timestamp that could
// drift out of sync with it.
//
// Without this, an agent's "matched"/"quote"/"done" update, or a live-chat
// reply, sent more than 24h after the customer's last message, would
// silently fail against the real WhatsApp API — a real gap, since a
// scheduled booking's agent follow-up often does land days after the
// customer last spoke to the bot.
//
// Backed by store.ts (Redis, with an automatic in-memory fallback) so a
// crash or redeploy doesn't drop a queued update.

import { kvGet, kvSet, kvDelete } from "./store";
import { getSession } from "./session";
import type { MediaAttachment } from "./server";

const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
const PENDING_KEY_PREFIX = "customer-pending:";

export type PendingCustomerItem =
  | { type: "text"; message: string }
  | { type: "media"; attachment: MediaAttachment };

// Capped per customer so one who never replies doesn't accumulate an
// unbounded backlog of queued agent updates.
const PENDING_LIMIT_PER_CUSTOMER = 20;

export async function isCustomerWindowOpen(phone: string): Promise<boolean> {
  const session = await getSession(phone);
  const last = session.data.lastCustomerMessageAt as number | undefined;
  if (!last) return false; // never heard from them — treat as closed
  return Date.now() - last < WHATSAPP_WINDOW_MS;
}

async function queuePendingCustomerItem(phone: string, item: PendingCustomerItem): Promise<void> {
  const key = `${PENDING_KEY_PREFIX}${phone}`;
  const existing = (await kvGet<PendingCustomerItem[]>(key)) ?? [];
  await kvSet(key, [...existing, item].slice(-PENDING_LIMIT_PER_CUSTOMER));
}

export async function queuePendingCustomerMessage(phone: string, message: string): Promise<void> {
  await queuePendingCustomerItem(phone, { type: "text", message });
}

export async function queuePendingCustomerMedia(phone: string, attachment: MediaAttachment): Promise<void> {
  await queuePendingCustomerItem(phone, { type: "media", attachment });
}

// Removes and returns everything queued for this customer — call once the
// window is confirmed open (i.e. right after they message the bot) so the
// real content can go out as normal free-form messages.
export async function drainPendingCustomerItems(phone: string): Promise<PendingCustomerItem[]> {
  const key = `${PENDING_KEY_PREFIX}${phone}`;
  const existing = (await kvGet<PendingCustomerItem[]>(key)) ?? [];
  await kvDelete(key);
  return existing;
}
