// Client for the REAL "Hustle @1" promo Supabase project ("Hustle
// DBAnnex", project ref mxaqgkdbyswksacqmyiv) — the same project already
// used by the live promos.hustleapp.io admin webapp (admin.html) and
// public promo page (promo.html). This is a SEPARATE database from the
// main Hustleapp app (which this bot still has no access to; see
// appApi.ts's mocked functions) — it holds promo-specific data only
// (entrants, submissions, point_rules, weekly_pools), never real Hustler
// account records.
//
// An earlier version of this file pointed at a different, invented
// standalone project this bot would have created itself. That was wrong —
// the real project already existed, built via a separate chat/webapp
// project, and was found by connecting the Supabase MCP connector and
// inspecting it directly. See docs/prd/0001-hustle-at-1-entry-system.md
// for the correction history. Don't recreate tables here; this bot only
// ever reads/writes the schema that's already live.
//
// Same conservative-fallback pattern as every other optional integration in
// this app (Redis, Google Sheets, Instagram sync): if SUPABASE_URL or
// SUPABASE_SERVICE_ROLE_KEY isn't set, getSupabase() returns null and
// callers (promoEntry.ts) skip the promo-entry feature entirely rather than
// crashing — a customer's screenshot just gets the normal image-description
// treatment instead of being logged as an entry.
//
// Deliberately uses the SERVICE ROLE key, not the anon key (the webapp uses
// the publishable/anon key client-side, which is fine there since RLS
// restricts anon to SELECT-only on a few tables — this bot needs to INSERT
// into entrants/submissions, which the real RLS policies restrict to
// admins/service-role only, so the anon key would not work here anyway).

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

// Matches the real bucket already created by/for the promos.hustleapp.io
// webapp (see admin.html's renderProof, which reads signed URLs from this
// same bucket) — kept as a named export so a rename stays a one-line change.
export const PROMO_SCREENSHOT_BUCKET = "submission-proofs";
