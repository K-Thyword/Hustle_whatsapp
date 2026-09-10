// Client for the "Hustle @1" promo's OWN, standalone Supabase project — a
// separate database from the main Hustleapp app (which this bot has no
// access to; see appApi.ts's mocked functions and docs/prd/0001-hustle-at-1
// -entry-system.md §2 for why). This module exists purely to talk to that
// promo database (submitters, promo_entries, category_points — see the
// migration in supabase/migrations/0001_promo_entries.sql).
//
// Same conservative-fallback pattern as every other optional integration in
// this app (Redis, Google Sheets, Instagram sync): if SUPABASE_URL or
// SUPABASE_SERVICE_ROLE_KEY isn't set, getSupabase() returns null and
// callers (promoEntry.ts) skip the promo-entry feature entirely rather than
// crashing — a customer's screenshot just gets the normal image-description
// treatment instead of being logged as an entry.
//
// Deliberately uses the SERVICE ROLE key, not the anon key — this service
// is a trusted backend (never exposed to a browser), and the RLS policies
// in the migration are intentionally empty (locked down to service-role-only
// access), so the anon key would be able to do nothing useful here anyway.

import { createClient, SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let client: SupabaseClient | null = null;
let warned = false;

export function getSupabase(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    if (!warned) {
      console.warn(
        "SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — promo entry logging is disabled; " +
          "screenshots will just get the normal image description instead."
      );
      warned = true;
    }
    return null;
  }
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false }, // server-side, no browser session to persist
    });
  }
  return client;
}

// Name matches the bucket created in the migration — kept as a named export
// (rather than a string literal repeated in promoEntry.ts) so renaming the
// bucket is a one-line change, not a grep-and-replace.
export const PROMO_SCREENSHOT_BUCKET = "promo-screenshots";
