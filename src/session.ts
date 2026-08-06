// In-memory session store, keyed by WhatsApp phone number.
// Swap for Redis or a DB table once you're past prototyping —
// this exists only so the rest of the app doesn't need to know
// how sessions are persisted (deletion test: everything below
// the interface can change without touching callers).

export type ConversationStage =
  | "greeting"
  | "awaiting_mode"
  | "awaiting_service_type"
  | "awaiting_location"
  | "awaiting_date"
  | "awaiting_date_confirmation"
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

const sessions = new Map<string, ConversationSession>();

export function getSession(phone: string): ConversationSession {
  const existing = sessions.get(phone);
  if (existing) return existing;

  const fresh: ConversationSession = {
    phone,
    stage: "greeting",
    data: {},
    updatedAt: Date.now(),
  };
  sessions.set(phone, fresh);
  return fresh;
}

export function updateSession(
  phone: string,
  updates: Partial<Pick<ConversationSession, "stage" | "data">>
): ConversationSession {
  const session = getSession(phone);
  const updated: ConversationSession = {
    ...session,
    ...updates,
    data: { ...session.data, ...(updates.data ?? {}) },
    updatedAt: Date.now(),
  };
  sessions.set(phone, updated);
  return updated;
}

// Full wipe — only use this if you genuinely want to forget this customer
// entirely. For "start a new booking" flows, use resetForNewRequest()
// instead so booking history and recent conversation context survive.
export function clearSession(phone: string): void {
  sessions.delete(phone);
}

// Resets a session back to "greeting" for a fresh booking, but keeps the
// persistent fields (past booking history, recent message log) so the bot
// doesn't lose all memory of this customer every time a booking wraps up.
export function resetForNewRequest(phone: string): ConversationSession {
  const session = getSession(phone);
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
  sessions.set(phone, fresh);
  return fresh;
}

// Adds a completed booking to this customer's history (survives resets).
export function addPastBooking(phone: string, booking: PastBooking): void {
  const session = getSession(phone);
  const existing = (session.data.pastBookings as PastBooking[] | undefined) ?? [];
  updateSession(phone, { data: { pastBookings: [...existing, booking] } });
}

// All active sessions — used by the inactivity check-in sweep to find
// customers who've gone quiet mid-booking. Returns live references, not
// copies, so callers can updateSession() as normal.
export function getAllSessions(): ConversationSession[] {
  return Array.from(sessions.values());
}

// Appends one line to a short rolling transcript of this customer's own
// messages (not the bot's replies) — enough for the FAQ AI to have some
// awareness of what's been discussed, without keeping unbounded history.
export function appendMessageLog(phone: string, text: string): void {
  if (!text) return;
  const session = getSession(phone);
  const existing = (session.data.messageLog as string[] | undefined) ?? [];
  const updatedLog = [...existing, text].slice(-MESSAGE_LOG_LIMIT);
  updateSession(phone, { data: { messageLog: updatedLog } });
}
