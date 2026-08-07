// Conversation session store, keyed by WhatsApp phone number. Backed by
// store.ts (Redis, with an automatic in-memory fallback) so a crash or
// redeploy no longer drops a customer mid-booking — this used to be a
// plain in-memory Map; the interface below is unchanged except that every
// function is now async, since talking to Redis is inherently async.

import { kvGet, kvSet, kvDelete, kvGetAllWithPrefix } from "./store";

export type ConversationStage =
  | "greeting"
  | "awaiting_mode"
  | "awaiting_service_type"
  | "awaiting_location"
  | "awaiting_date"
  | "awaiting_date_confirmation"
  | "awaiting_extraction_confirmation" // confirming service/location/date already given in the opening message
  | "awaiting_extra_details" // service-specific follow-ups, recurring, budget
  | "awaiting_description"
  | "awaiting_special_instructions"
  | "awaiting_confirmation"
  | "request_submitted"
  | "escalated";

export interface ConversationSession {
  phone: string;
  stage: ConversationStage;
  data: Record<string, unknown>;
  updatedAt: number;
}

// A short record of a booking this customer already submitted — kept
// around across resets (unlike the rest of session.data) so the bot can
// stay aware of it if the customer references "my last booking" later,
// and so agent-facing context has some history to draw on.
export interface PastBooking {
  requestId: string;
  mode: string;
  serviceType: string;
  location: string;
  dateWanted?: string;
  description: string;
  specialInstructions?: string;
  recurring?: string; // e.g. "one-time" or "regular" — only asked for some trades
  budget?: string; // rough budget the customer gave, for quote-type jobs
  submittedAt: number;
}

// Fields in session.data that survive a reset (starting a new booking,
// restarting after "no", etc.) — everything else in .data is wiped so a
// new booking never inherits stale fields (attachments, service type...)
// from a previous one, while still remembering who this customer is.
const PERSISTENT_DATA_KEYS = ["pastBookings", "messageLog"] as const;

const MESSAGE_LOG_LIMIT = 20;

const SESSION_KEY_PREFIX = "session:";
function sessionKey(phone: string): string {
  return `${SESSION_KEY_PREFIX}${phone}`;
}

export async function getSession(phone: string): Promise<ConversationSession> {
  const existing = await kvGet<ConversationSession>(sessionKey(phone));
  if (existing) return existing;

  const fresh: ConversationSession = {
    phone,
    stage: "greeting",
    data: {},
    updatedAt: Date.now(),
  };
  await kvSet(sessionKey(phone), fresh);
  return fresh;
}

export async function updateSession(
  phone: string,
  updates: Partial<Pick<ConversationSession, "stage" | "data">>
): Promise<ConversationSession> {
  const session = await getSession(phone);
  const updated: ConversationSession = {
    ...session,
    ...updates,
    data: { ...session.data, ...(updates.data ?? {}) },
    updatedAt: Date.now(),
  };
  await kvSet(sessionKey(phone), updated);
  return updated;
}

// Full wipe — only use this if you genuinely want to forget this customer
// entirely. For "start a new booking" flows, use resetForNewRequest()
// instead so booking history and recent conversation context survive.
export async function clearSession(phone: string): Promise<void> {
  await kvDelete(sessionKey(phone));
}

// Resets a session back to "greeting" for a fresh booking, but keeps the
// persistent fields (past booking history, recent message log) so the bot
// doesn't lose all memory of this customer every time a booking wraps up.
export async function resetForNewRequest(phone: string): Promise<ConversationSession> {
  const session = await getSession(phone);
  const persisted: Record<string, unknown> = {};
  for (const key of PERSISTENT_DATA_KEYS) {
    if (key in session.data) persisted[key] = session.data[key];
  }
  const fresh: ConversationSession = {
    phone,
    stage: "greeting",
    data: persisted,
    updatedAt: Date.now(),
  };
  await kvSet(sessionKey(phone), fresh);
  return fresh;
}

// Adds a completed booking to this customer's history (survives resets).
export async function addPastBooking(phone: string, booking: PastBooking): Promise<void> {
  const session = await getSession(phone);
  const existing = (session.data.pastBookings as PastBooking[] | undefined) ?? [];
  await updateSession(phone, { data: { pastBookings: [...existing, booking] } });
}

// All active sessions — used by the inactivity check-in sweep to find
// customers who've gone quiet mid-booking.
export async function getAllSessions(): Promise<ConversationSession[]> {
  return kvGetAllWithPrefix<ConversationSession>(SESSION_KEY_PREFIX);
}

// Appends one line to a short rolling transcript of this customer's own
// messages (not the bot's replies) — enough for the FAQ AI to have some
// awareness of what's been discussed, without keeping unbounded history.
export async function appendMessageLog(phone: string, text: string): Promise<void> {
  if (!text) return;
  const session = await getSession(phone);
  const existing = (session.data.messageLog as string[] | undefined) ?? [];
  const updatedLog = [...existing, text].slice(-MESSAGE_LOG_LIMIT);
  await updateSession(phone, { data: { messageLog: updatedLog } });
}
