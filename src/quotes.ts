// Tracks the back-and-forth between a customer and the agent sourcing a
// provider for them, for jobs that need a price quote rather than a fixed
// price. Deliberately separate from session.ts: this is keyed by request
// reference (agents refer to jobs by their reference number, not a phone
// number), and it needs to stay "live" independently of the customer's own
// conversation stage, which resets back to "greeting" right after a
// booking is submitted.

export type QuoteStatus =
  | "awaiting_quote" // submitted; agent/artisan haven't priced it yet
  | "awaiting_customer_info" // artisan needs more details before pricing
  | "quoted" // customer has been given a price, awaiting accept/decline
  | "confirmed" // customer accepted
  | "declined";

export interface QuoteRequest {
  requestId: string;
  phone: string;
  serviceType: string;
  location: string;
  status: QuoteStatus;
  quoteAmount?: string;
}

const quoteRequests = new Map<string, QuoteRequest>();

export function createQuoteRequest(input: {
  requestId: string;
  phone: string;
  serviceType: string;
  location: string;
}): void {
  quoteRequests.set(input.requestId, { ...input, status: "awaiting_quote" });
}

export function getQuoteRequest(requestId: string): QuoteRequest | undefined {
  return quoteRequests.get(requestId);
}

export function updateQuoteRequest(
  requestId: string,
  updates: Partial<QuoteRequest>
): QuoteRequest | undefined {
  const existing = quoteRequests.get(requestId);
  if (!existing) return undefined;
  const updated = { ...existing, ...updates };
  quoteRequests.set(requestId, updated);
  return updated;
}

// Finds this customer's request that's actively waiting on THEM
// specifically — either to answer a question, or to accept/decline a
// price — not just any request sitting in the passive "awaiting_quote"
// state, so a customer starting an unrelated new conversation isn't
// hijacked into replying to an old, dormant request.
export function getPendingCustomerAction(phone: string): QuoteRequest | undefined {
  for (const request of quoteRequests.values()) {
    if (
      request.phone === phone &&
      (request.status === "awaiting_customer_info" || request.status === "quoted")
    ) {
      return request;
    }
  }
  return undefined;
}
