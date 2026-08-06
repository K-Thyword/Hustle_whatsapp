// Tracks an active human-handled conversation with a customer — separate
// from quotes.ts (which tracks a booking's pricing lifecycle), because a
// live chat can exist with or without an active booking (e.g. a customer
// just asking to speak to a person, or a complaint unrelated to any
// specific request). Keyed by customer phone, since a customer only ever
// has one active live chat at a time.
//
// The claim here is what gives "only one agent talks to this customer at
// once" its teeth — combined with the fact that only numbers in
// AGENT_NOTIFY_NUMBERS are ever treated as agents in the first place
// (server.ts's webhook handler), a customer can only ever be relayed
// messages from a number that is both (a) an authorised agent number and
// (b) the one that claimed this specific conversation.

export interface LiveChat {
  phone: string;
  claimedBy?: string; // agent phone number
  claimedAt?: number;
  startedAt: number;
  unclaimedNudgeSent?: boolean;
}

const liveChats = new Map<string, LiveChat>();

// Idempotent — if a live chat is already open for this phone (e.g. the
// customer sent another escalation-triggering message before anyone
// claimed the first one), this leaves the existing one (and any claim on
// it) untouched rather than clobbering it.
export function startLiveChat(phone: string): LiveChat {
  const existing = liveChats.get(phone);
  if (existing) return existing;
  const chat: LiveChat = { phone, startedAt: Date.now() };
  liveChats.set(phone, chat);
  return chat;
}

export function getLiveChat(phone: string): LiveChat | undefined {
  return liveChats.get(phone);
}

export function claimLiveChat(phone: string, agentPhone: string): LiveChat | undefined {
  const chat = liveChats.get(phone);
  if (!chat) return undefined;
  const updated: LiveChat = { ...chat, claimedBy: agentPhone, claimedAt: Date.now() };
  liveChats.set(phone, updated);
  return updated;
}

export function unclaimLiveChat(phone: string): LiveChat | undefined {
  const chat = liveChats.get(phone);
  if (!chat) return undefined;
  const updated: LiveChat = { ...chat, claimedBy: undefined, claimedAt: undefined };
  liveChats.set(phone, updated);
  return updated;
}

export function endLiveChat(phone: string): void {
  liveChats.delete(phone);
}

export function getAllLiveChats(): LiveChat[] {
  return Array.from(liveChats.values());
}

export function markLiveChatNudgeSent(phone: string): void {
  const chat = liveChats.get(phone);
  if (!chat) return;
  liveChats.set(phone, { ...chat, unclaimedNudgeSent: true });
}
