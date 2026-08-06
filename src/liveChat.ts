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

// One line of the conversation while it's human-handled — kept so that if
// an agent transfers the chat to a colleague, the new agent isn't starting
// cold. agentPhone is set on "agent" entries so a transcript that spans
// more than one agent (multiple transfers) can still attribute each line
// correctly instead of assuming they were all the same person.
export interface LiveChatTranscriptEntry {
  from: "customer" | "agent";
  text: string;
  at: number;
  agentPhone?: string;
}

const TRANSCRIPT_LIMIT = 30;

export interface LiveChat {
  phone: string;
  claimedBy?: string; // agent phone number
  claimedAt?: number;
  startedAt: number;
  unclaimedNudgeSent?: boolean;
  transcript: LiveChatTranscriptEntry[];
}

const liveChats = new Map<string, LiveChat>();

// Idempotent — if a live chat is already open for this phone (e.g. the
// customer sent another escalation-triggering message before anyone
// claimed the first one), this leaves the existing one (and any claim on
// it) untouched rather than clobbering it.
export function startLiveChat(phone: string): LiveChat {
  const existing = liveChats.get(phone);
  if (existing) return existing;
  const chat: LiveChat = { phone, startedAt: Date.now(), transcript: [] };
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

// Records one line of a claimed conversation. No-op if the chat doesn't
// exist (e.g. race with it just having ended) — this is purely a
// convenience log for transfers, never the source of truth for anything.
export function appendLiveChatMessage(
  phone: string,
  from: "customer" | "agent",
  text: string,
  agentPhone?: string
): void {
  if (!text) return;
  const chat = liveChats.get(phone);
  if (!chat) return;
  const entry: LiveChatTranscriptEntry = { from, text, at: Date.now(), agentPhone };
  const updatedTranscript = [...chat.transcript, entry].slice(-TRANSCRIPT_LIMIT);
  liveChats.set(phone, { ...chat, transcript: updatedTranscript });
}

export function getAllLiveChats(): LiveChat[] {
  return Array.from(liveChats.values());
}

export function markLiveChatNudgeSent(phone: string): void {
  const chat = liveChats.get(phone);
  if (!chat) return;
  liveChats.set(phone, { ...chat, unclaimedNudgeSent: true });
}

// --- Per-agent "active conversation" pointer ---
// An agent still needs the customer's number the first time (to claim a
// specific conversation), but after that, plain messages with no
// phone-number prefix are understood to mean "keep talking to whoever I
// just claimed/messaged" — this is what that pointer tracks. Claiming a
// conversation, or explicitly messaging one by number, both set it;
// ending a conversation clears it. An agent juggling more than one
// claimed conversation can always switch which one is "active" by using
// the explicit "<phone>: <message>" form.
const activeChatByAgent = new Map<string, string>();

export function setActiveChatForAgent(agentPhone: string, customerPhone: string): void {
  activeChatByAgent.set(agentPhone, customerPhone);
}

export function getActiveChatForAgent(agentPhone: string): string | undefined {
  return activeChatByAgent.get(agentPhone);
}

export function clearActiveChatForAgent(agentPhone: string): void {
  activeChatByAgent.delete(agentPhone);
}
