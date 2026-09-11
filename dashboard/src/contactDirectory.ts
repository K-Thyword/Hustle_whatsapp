// Read-only mirror of the bot's src/contactDirectory.ts — same shared
// Redis instance (see readState.ts's header for how that's wired up
// between the two Railway services), same key prefix, same
// graceful-degrade-to-memory pattern. This module never writes; only the
// bot ever calls saveContactProfile.
//
// Exists so a customer identified by a Business-Scoped User ID (BSUID,
// e.g. "GH.2522884254883161") instead of a phone number shows up in the
// Chats tab as a recognizable name/username rather than just an opaque ID
// — their real phone number is never available to us at all once they've
// hidden it behind a WhatsApp username (a deliberate Meta privacy
// feature), so this display name is the only human-readable identity an
// agent has to go on.

import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = "contact-profile:";

export interface ContactProfile {
  name?: string;
  username?: string;
}

type Client = ReturnType<typeof createClient>;
let client: Client | null = null;
let connecting: Promise<Client | null> | null = null;

async function getClient(): Promise<Client | null> {
  if (!REDIS_URL) return null;
  if (client) return client;
  if (!connecting) {
    connecting = (async () => {
      try {
        const c = createClient({ url: REDIS_URL });
        c.on("error", (err) => console.error("Redis client error (dashboard contact directory):", err));
        await c.connect();
        client = c;
        return c;
      } catch (err) {
        console.error("Redis connection failed, dashboard contact directory falling back to empty:", err);
        connecting = null;
        return null;
      }
    })();
  }
  return connecting;
}

// Everything ever captured, as phone/BSUID -> profile — used once per
// Chats-tab load to enrich every conversation in one pass, same shape as
// readState.ts's getAllLastSeen(). No in-memory fallback here (unlike
// readState.ts): this module never writes, so there's nothing to fall back
// to — a Redis outage just means no display names this load, not stale or
// wrong ones.
export async function getAllContactProfiles(): Promise<Record<string, ContactProfile>> {
  try {
    const c = await getClient();
    if (!c) return {};

    const keys: string[] = [];
    for await (const key of c.scanIterator({ MATCH: `${KEY_PREFIX}*` })) {
      keys.push(key);
    }
    if (keys.length === 0) return {};

    const values = await c.mGet(keys);
    const out: Record<string, ContactProfile> = {};
    keys.forEach((key, i) => {
      const v = values[i];
      if (v) out[key.slice(KEY_PREFIX.length)] = JSON.parse(v) as ContactProfile;
    });
    return out;
  } catch (err) {
    console.error("Contact directory scan failed:", err);
    return {};
  }
}
