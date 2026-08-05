// Client for the main Hustleapp backend. Every function is mocked for now
// so you can build and test the WhatsApp flow without waiting on the app
// dev team. Once real endpoints exist, replace the mock bodies with real
// fetch() calls to APP_API_BASE_URL — nothing calling these functions
// needs to change.
//
// Important: Hustleapp connects customers with artisans/professionals —
// there is no live/real-time list of available providers. A booking
// request is submitted with the customer's details, and a human agent
// manually sources and confirms a provider. This is a request/ticket
// model, not an "available providers, pick one" model.

export interface AppUser {
  id: string;
  phone: string;
  name?: string;
}

export async function findOrCreateUserByPhone(phone: string): Promise<AppUser> {
  // MOCK — replace with real GET /users/by-phone, falling back to POST /users
  return { id: `user_${phone}`, phone };
}

export type BookingMode = "standard" | "instant";

export interface BookingRequestInput {
  userId: string;
  mode: BookingMode;
  serviceType: string; // e.g. "plumber", "electrician", "accountant", "tutor"
  location: string;
  dateWanted?: string; // only present for standard (scheduled) bookings
  description: string;
  channel: "whatsapp";
}

export interface BookingRequestResult {
  requestId: string;
  status: string; // e.g. "submitted" — agents pick this up manually
}

export async function submitBookingRequest(
  input: BookingRequestInput
): Promise<BookingRequestResult> {
  // MOCK — replace with real POST /booking-requests
  console.log("[MOCK submitBookingRequest]", input);
  return { requestId: `req_${Date.now()}`, status: "submitted" };
}

export async function getBookingRequestStatus(requestId: string): Promise<string> {
  // MOCK — replace with real GET /booking-requests/{id}/status
  return "submitted";
}
