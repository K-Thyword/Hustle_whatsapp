// A tiny persistence seam for this service's OWN runtime state — sessions,
// quote requests, live chats, agent message queues. This is deliberately
// NOT the main Hustleapp app database (that lives behind appApi.ts, and
// once real endpoints exist, orders/users/providers flow through there,
// not here). This module exists purely so a crash or redeploy of the
// WhatsApp service itself doesn't wipe every conversation and claim that
// was in flight — the same class of bug that nearly caused real damage
// during an earlier incident on this project.
//
// Everything downstream (session.ts, quotes.ts, liveChat.ts,
// agentMessaging.ts) keeps calling a small get/set/delete/list interface;
// only what's underneath it changes. If REDIS_URL isn't set (local dev,
// or before Redis is provisioned on Railway), this falls back to an
// in-memory Map automatically — same conservative-fallback pattern used
// everywhere else in this app (ANTHROPIC_API_KEY, OPENAI_API_KEY,
// WHATSAPP_ACCESS_TOKEN all degrade gracefully instead of crashing).

import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_URL;

type Client = ReturnType<typeof createClient>;

let client: Client | null = null;
let connecting: Promise<Client | null> | null = null;

// Mirror of everything ever written, kept regardless of whether Redis is
// configured — this is what reads/writes fall back to if Redis is
// unreachable, so a blip in Redis degrades to "acts like before this
// change" rather than a hard failure.
const memoryStore = new Map<string, string>();

async function getClient(): Promise<Client | null> {
  if (!REDIS_URL) return null;
  if (client) return client;
  if (!connecting) {
    connecting = (async () => {
      try {
        const c = createClient({ url: REDIS_URL });
        c.on("error", (err) => console.error("Redis client error:", err));
        await c.connect();
        client = c;
        return c;
      } catch (err) {
        console.error("Redis connection failed, falling back to in-memory store:", err);
        connecting = null;
        return null;
      }
    })();
  }
  return connecting;
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    const c = await getClient();
    const raw = c ? await c.get(key) : memoryStore.get(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch (err) {
    console.error(`Store read failed for "${key}", falling back to in-memory value:`, err);
    const raw = memoryStore.get(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  }
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  const raw = JSON.stringify(value);
  memoryStore.set(key, raw); // always mirrored, so a later Redis outage still has a fallback
  try {
    const c = await getClient();
    if (c) await c.set(key, raw);
  } catch (err) {
    console.error(`Store write failed for "${key}", kept in memory only:`, err);
  }
}

export async function kvDelete(key: string): Promise<void> {
  memoryStore.delete(key);
  try {
    const c = await getClient();
    if (c) await c.del(key);
  } catch (err) {
    console.error(`Store delete failed for "${key}":`, err);
  }
}

// Lists every value stored under a key prefix (e.g. "session:") — used by
// sweeps and lookups that need to scan everything of one kind, not fetch
// one known key. Fine at this app's scale (tens to low hundreds of
// concurrent conversations); would need a real index if that grows a lot.
export async function kvGetAllWithPrefix<T>(prefix: string): Promise<T[]> {
  try {
    const c = await getClient();
    if (!c) return memoryEntriesWithPrefix<T>(prefix);

    const keys: string[] = [];
    for await (const key of c.scanIterator({ MATCH: `${prefix}*` })) {
      keys.push(key);
    }
    if (keys.length === 0) return [];
    const values = await c.mGet(keys);
    return values.filter((v): v is string => v !== null).map((v) => JSON.parse(v) as T);
  } catch (err) {
    console.error(`Store scan failed for prefix "${prefix}", falling back to in-memory values:`, err);
    return memoryEntriesWithPrefix<T>(prefix);
  }
}

function memoryEntriesWithPrefix<T>(prefix: string): T[] {
  return Array.from(memoryStore.entries())
    .filter(([k]) => k.startsWith(prefix))
    .map(([, v]) => JSON.parse(v) as T);
}
