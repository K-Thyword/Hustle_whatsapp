// Client for the main Hustleapp backend — the four endpoints from the
// requirements doc sent to the app dev team. Every function is mocked
// for now so you can build the WhatsApp flow without waiting on them.
// Once real endpoints exist, replace the mock bodies with real fetch()
// calls to APP_API_BASE_URL — nothing calling these functions needs to change.

export interface Provider {
  id: string;
  name: string;
  serviceType: string;
  etaMinutes: number;
}

export async function getAvailableProviders(
  serviceType: string,
  _location?: string
): Promise<Provider[]> {
  // MOCK — replace with:
  // const res = await fetch(`${process.env.APP_API_BASE_URL}/providers/available?...`)
  return [
    { id: "p1", name: "Kojo (Bike)", serviceType, etaMinutes: 12 },
    { id: "p2", name: "Ama (Bike)", serviceType, etaMinutes: 18 },
  ];
}

export interface AppUser {
  id: string;
  phone: string;
  name?: string;
}

export async function findOrCreateUserByPhone(phone: string): Promise<AppUser> {
  // MOCK — replace with real GET /users/by-phone, falling back to POST /users
  return { id: `user_${phone}`, phone };
}

export interface OrderInput {
  userId: string;
  providerId: string;
  serviceType: string;
  channel: "whatsapp";
}

export interface OrderResult {
  orderId: string;
  status: string;
}

export async function createOrder(input: OrderInput): Promise<OrderResult> {
  // MOCK — replace with real POST /orders
  return { orderId: `order_${Date.now()}`, status: "pending" };
}

export async function getOrderStatus(orderId: string): Promise<string> {
  // MOCK — replace with real GET /orders/{id}/status
  return "pending";
}
