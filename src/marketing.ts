// Tracks which customers have explicitly opted in to receive promotional
// content (campaign broadcasts, the 30-day win-back check-in) — separate
// from the rest of the booking flow because WhatsApp requires real,
// explicit consent before sending marketing content, and that consent
// needs to survive independently of any one booking's lifecycle.
//
// This is NOT the same permission as talking to the bot at all — a
// customer who has never opted in can still book normally forever; they
// just never receive proactive marketing/win-back messages. Only phones
// with an explicit opt-in are ever eligible for those two send paths.
//
// Backed by store.ts (Redis, with an automatic in-memory fallback), same
// as every other piece of this service's state.

import { kvGet, kvSet, kvGetAllWithPrefix } from "./store";

export interface MarketingOptIn {
  phone: string;
  optedIn: boolean;
  optedInAt?: number;
  optedOutAt?: number;
}

const OPT_IN_KEY_PREFIX = "marketing-optin:";
function optInKey(phone: string): string {
  return `${OPT_IN_KEY_PREFIX}${phone}`;
}

export async function setMarketingOptIn(phone: string, optedIn: boolean): Promise<void> {
  const now = Date.now();
  const record: MarketingOptIn = optedIn
    ? { phone, optedIn: true, optedInAt: now }
    : { phone, optedIn: false, optedOutAt: now };
  await kvSet(optInKey(phone), record);
}

export async function isOptedIn(phone: string): Promise<boolean> {
  const record = await kvGet<MarketingOptIn>(optInKey(phone));
  return record?.optedIn === true;
}

// Every phone that's currently opted in — used by the broadcast command
// and the win-back sweep to build the send list.
export async function getOptedInPhones(): Promise<string[]> {
  const all = await kvGetAllWithPrefix<MarketingOptIn>(OPT_IN_KEY_PREFIX);
  return all.filter((r) => r.optedIn).map((r) => r.phone);
}
