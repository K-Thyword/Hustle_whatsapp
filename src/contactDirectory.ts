// Tracks each customer's own WhatsApp display name/username, captured
// straight from the "contacts" object every inbound webhook carries — not
// identity we asked for or verified, just what WhatsApp itself already
// knows about them.
//
// Exists specifically for customers identified by a Business-Scoped User ID
// (BSUID, e.g. "GH.2522884254883161" — see server.ts's BSUID_RE) instead of
// a phone number: once a customer hides their number behind a WhatsApp
// username, Meta deliberately withholds their real phone number from us
// entirely — there is no way to get it, by design (that's the whole point
// of the privacy feature). This display name/username is the only
// human-readable way an agent has to recognize who they're actually
// talking to in the dashboard. Captured for every customer, not just BSUID
// ones, since it's free and still useful (a name is easier to recognize at
// a glance than a bare phone number).
//
// Redis-backed via store.ts, same conservative in-memory-fallback pattern
// as session.ts/reminders.ts/etc. — a missing name here just means the
// dashboard falls back to showing the bare phone/BSUID, never a crash.

import { kvGet, kvSet } from "./store";

const KEY_PREFIX = "contact-profile:";

export interface ContactProfile {
  name?: string;
  username?: string;
}

export async function saveContactProfile(phone: string, profile: ContactProfile): Promise<void> {
  if (!profile.name && !profile.username) return;
  const existing = await getContactProfile(phone);
  // Merge rather than overwrite — a later message might carry a username
  // but not a name (or vice versa), and we don't want a partial update to
  // erase what we already learned.
  await kvSet(`${KEY_PREFIX}${phone}`, {
    name: profile.name ?? existing?.name,
    username: profile.username ?? existing?.username,
  });
}

export async function getContactProfile(phone: string): Promise<ContactProfile | undefined> {
  return kvGet<ContactProfile>(`${KEY_PREFIX}${phone}`);
}
