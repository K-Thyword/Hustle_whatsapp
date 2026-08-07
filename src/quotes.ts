// Tracks the full lifecycle of a booking request from an agent/coordination
// point of view — quoting, who's claimed it, whether it's done, and any
// customer review — separate from session.ts because agents refer to jobs
// by their reference number (not a phone number), and this needs to stay
// "live" independently of the customer's own conversation stage, which
// resets back to "greeting" right after a booking is submitted.
//
// Backed by store.ts (Redis, with an automatic in-memory fallback) so a
// crash or redeploy doesn't drop who's claimed what mid-negotiation.

import { kvGet, kvSet, kvGetAllWithPrefix } from "./store";

export type QuoteStatus =
  | "awaiting_quote" // submitted; agent/artisan haven't priced it yet
  | "awaiting_customer_info" // artisan needs more details before pricing
  | "quoted" // customer has been given a price, awaiting accept/decline
  | "confirmed" // customer accepted
  | "completed" // agent marked the job done, customer not yet asked to review
  | "reviewed" // customer has given feedback — terminal
  | "declined" // customer declined the quote
  | "cancelled"; // customer cancelled the request outright

// Requests still "open" in the sense that someone (agent or customer) is
// expected to act on them next — used for the unclaimed-request nudge and
// for finding a customer's most recent cancellable request.
export const OPEN_STATUSES: QuoteStatus[] = [
  "awaiting_quote",
  "awaiting_customer_info",
  "quoted",
  "confirmed",
];

export interface QuoteRequest {
  requestId: string;
  phone: string;
  serviceType: string;
  location: string;
  mode: string; // "instant" | "standard" — used to size the unclaimed-nudge threshold
  status: QuoteStatus;
  quoteAmount?: string;
  matchedProvider?: string; // set once an agent tells us who the job went to
  claimedBy?: string; // agent phone number who claimed it, if any
  claimedAt?: number;
  unclaimedNudgeSent?: boolean;
  createdAt: number;
}

const QUOTE_KEY_PREFIX = "quote:";
function quoteKey(requestId: string): string {
  return `${QUOTE_KEY_PREFIX}${requestId}`;
}

export async function createQuoteRequest(input: {
  requestId: string;
  phone: string;
  serviceType: string;
  location: string;
  mode: string;
}): Promise<void> {
  const record: QuoteRequest = {
    ...input,
    status: "awaiting_quote",
    createdAt: Date.now(),
  };
  await kvSet(quoteKey(input.requestId), record);
}

export async function getQuoteRequest(requestId: string): Promise<QuoteRequest | undefined> {
  return kvGet<QuoteRequest>(quoteKey(requestId));
}

export async function updateQuoteRequest(
  requestId: string,
  updates: Partial<QuoteRequest>
): Promise<QuoteRequest | undefined> {
  const existing = await getQuoteRequest(requestId);
  if (!existing) return undefined;
  const updated = { ...existing, ...updates };
  await kvSet(quoteKey(requestId), updated);
  return updated;
}

export async function getAllQuoteRequests(): Promise<QuoteRequest[]> {
  return kvGetAllWithPrefix<QuoteRequest>(QUOTE_KEY_PREFIX);
}

// Finds this customer's request that's actively waiting on THEM
// specifically — either to answer a question, accept/decline a price, or
// give a post-job review — not just any request sitting in the passive
// "awaiting_quote" state, so a customer starting an unrelated new
// conversation isn't hijacked into replying to an old, dormant request.
export async function getPendingCustomerAction(phone: string): Promise<QuoteRequest | undefined> {
  const all = await getAllQuoteRequests();
  return all.find(
    (request) =>
      request.phone === phone &&
      (request.status === "awaiting_customer_info" ||
        request.status === "quoted" ||
        request.status === "completed")
  );
}

// Most recent request for this phone that's still "open" (not already
// cancelled, completed+reviewed, or declined) — used by the "cancel my
// last request" path so it can find the right job without the customer
// needing to know their own reference number.
export async function getLatestActiveRequestForPhone(phone: string): Promise<QuoteRequest | undefined> {
  const all = await getAllQuoteRequests();
  const candidates = all
    .filter((r) => r.phone === phone && OPEN_STATUSES.includes(r.status))
    .sort((a, b) => b.createdAt - a.createdAt);
  return candidates[0];
}
