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
  | "awaiting_description"
  | "awaiting_confirmation"
  | "request_submitted"
  | "escalated";

export interface ConversationSession {
  phone: string;
  stage: ConversationStage;
  data: Record<string, unknown>;
  updatedAt: number;
}

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

export function clearSession(phone: string): void {
  sessions.delete(phone);
}
