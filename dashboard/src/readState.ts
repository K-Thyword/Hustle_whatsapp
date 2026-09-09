// Tracks when each phone number's conversation was last opened in the
// dashboard, so unread badges persist across page loads, days, and devices
// instead of resetting silently. The first version of this lived entirely
// in browser localStorage — it turned out that doesn't behave like durable
// storage in practice (private windows, "clear on close" browser settings,
// or just opening the dashboard from a different device) — a real report
// was "opened everything to read it, woke up the next day, it was all back
// to unread again." This module makes "seen" a real, shared fact instead
// of a per-browser guess, so it survives all of that.
//
// The dashboard is otherwise entirely read-only against the Google Sheet
// (see sheetsData.ts) — this is the one thing it persists, and it's kept
// deliberately separate: its own Redis key prefix (never touches anything
// the bot writes), and the same graceful-degrade-to-memory pattern the
// bot's own store.ts uses, so a Redis hiccup here can never affect the bot
// and never crashes the dashboard either — it just stops surviving restarts
// until Redis is reachable again.
//
// Reuses the SAME Redis instance as the bot service (they're two Railway
// services in one project) — set REDIS_URL on this service to the same
// value as the bot's (Railway's "Shared Variable" reference works well for
// this). If it's not set, this falls back to an in-memory map, which means
// "seen" state won't survive a redeploy of the dashboard, but everything
// else keeps working.

import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = "dashboard-chat-seen:";

type Client = ReturnType<typeof createClient>;
let client: Client | null = null;
let connecting: Promise<Client | null> | null = null;

// Always-mirrored fallback, same pattern as the bot's store.ts — a Redis
// outage degrades to "acts like the old localStorage version" rather than
// erroring.
const memoryStore = new Map<string, string>();

async function getClient(): Promise<Client | null> {
  if (!REDIS_URL) return null;
  if (client) return client;
  if (!connecting) {
    connecting = (async () => {
      try {
        const c = createClient({ url: REDIS_URL });
        c.on("error", (err) => console.error("Redis client error (dashboard read-state):", err));
        await c.connect();
        client = c;
        return c;
      } catch (err) {
        console.error("Redis connection failed, dashboard read-state falling back to in-memory:", err);
        connecting = null;
        return null;
      }
    })();
  }
  return connecting;
}

export async function markSeen(phone: string, atIso: string = new Date().toISOString()): Promise<void> {
  const key = `${KEY_PREFIX}${phone}`;
  memoryStore.set(key, atIso);
  try {
    const c = await getClient();
    if (c) await c.set(key, atIso);
  } catch (err) {
    console.error(`Read-state write failed for "${phone}", kept in memory only:`, err);
  }
}

// Everything ever marked seen, as phone -> ISO timestamp — used once per
// Chats-tab load to compute unread counts against every conversation in
// one pass, rather than one Redis round-trip per phone.
export async function getAllLastSeen(): Promise<Record<string, string>> {
  const fromMemory = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of memoryStore) {
      if (k.startsWith(KEY_PREFIX)) out[k.slice(KEY_PREFIX.length)] = v;
    }
    return out;
  };

  try {
    const c = await getClient();
    if (!c) return fromMemory();

    const keys: string[] = [];
    for await (const key of c.scanIterator({ MATCH: `${KEY_PREFIX}*` })) {
      keys.push(key);
    }
    if (keys.length === 0) return {};

    const values = await c.mGet(keys);
    const out: Record<string, string> = {};
    keys.forEach((key, i) => {
      const v = values[i];
      if (v) out[key.slice(KEY_PREFIX.length)] = v;
    });
    return out;
  } catch (err) {
    console.error("Read-state scan failed, falling back to in-memory values:", err);
    return fromMemory();
  }
}
