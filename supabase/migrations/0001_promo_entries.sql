-- "Hustle @1" promo entry system — standalone schema, per docs/prd/0001-hustle-at-1-entry-system.md
--
-- This is a NEW, separate Supabase project (per the decision recorded in the
-- PRD) — it does NOT contain real Hustler/user accounts; those live in the
-- main Hustleapp app's own database, which this project has no access to.
-- `submitters` here is just "whoever has been messaging the bot from this
-- phone number, and whatever identity they've claimed" — not a verified
-- account. Turning a submitter into a real Hustler account is a manual step
-- an admin does in the main app, using the claimed_name/claimed_email as a
-- search hint (see PRD §3 for why email > name > phone as a matching key).
--
-- How to apply: paste into the Supabase SQL editor for the new project, or
-- `supabase db push` if you're using the CLI locally.

-- Real, queryable point values per category — the entry system's source of
-- truth. (The bot's own FAQ copy in src/promoInfo.ts is currently separate,
-- hand-written prose for customer-facing answers — see PRD §9, an open item
-- to keep the two in sync, not solved by this migration.) Seeded from the
-- values in src/promoInfo.ts as of 2026-09-10.
create table if not exists public.category_points (
  category text not null,
  category_detail text not null default '',
  points integer not null,
  is_weekly boolean not null default false, -- e.g. content_post is +15/week, not one-time
  uncapped boolean not null default false,  -- only "booking" is uncapped today
  label text not null,                      -- human-readable, for the admin queue UI
  primary key (category, category_detail)
);

insert into public.category_points (category, category_detail, points, is_weekly, uncapped, label) values
  ('signup', '', 10, false, false, 'Signed up'),
  ('profile_complete', '', 15, false, false, 'Completed profile'),
  ('booking', '', 20, false, true, 'Received a completed & paid booking'),
  ('social_follow', 'instagram', 5, false, false, 'Followed on Instagram'),
  ('social_follow', 'facebook', 5, false, false, 'Followed on Facebook'),
  ('social_follow', 'tiktok', 5, false, false, 'Followed on TikTok'),
  ('social_follow', 'x', 5, false, false, 'Followed on X'),
  ('social_follow', 'youtube', 5, false, false, 'Followed on YouTube'),
  ('content_post', '', 15, true, false, 'Posted with #HustleAppTurns1'),
  ('share', '', 10, false, false, 'Shared the anniversary post'),
  ('like_comment', 'like', 2, false, false, 'Liked a HustleApp post'),
  ('like_comment', 'comment', 3, false, false, 'Commented on a HustleApp post')
on conflict (category, category_detail) do nothing;

-- Whoever has messaged the bot about the promo, keyed by WhatsApp phone
-- number — NOT a verified account. claimed_name/claimed_email are
-- backfilled from the first entry that has them (extracted from a
-- screenshot, or asked directly if none was legible) and reused on later
-- entries from the same phone so we don't ask twice.
create table if not exists public.submitters (
  id uuid primary key default gen_random_uuid(),
  whatsapp_phone text not null unique,
  claimed_name text,
  claimed_email text,
  created_at timestamptz not null default now()
);

create table if not exists public.promo_entries (
  id uuid primary key default gen_random_uuid(),
  submitter_id uuid not null references public.submitters(id),

  category text not null,
  category_detail text not null default '',

  -- Supabase Storage path, NOT a WhatsApp media ID/URL — those expire and
  -- aren't reliably retained, so the bot downloads bytes at receipt time
  -- and uploads them here immediately (see PRD §6). Bucket declared below.
  screenshot_path text not null,

  ai_suggested_category text,
  ai_suggested_category_detail text,
  ai_confidence numeric(3,2), -- 0.00–1.00
  ai_extracted_name text,
  ai_extracted_email text,
  ai_raw_response jsonb, -- full classifier output, kept for debugging/tuning the prompt

  booking_reference text, -- only meaningful for category = 'booking'; lets an
                           -- admin cross-check against this bot's own request
                           -- logs (see googleSheet.ts / dashboard Requests tab)

  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  points_awarded integer,
  fraud_flags jsonb not null default '[]'::jsonb, -- populated in a later phase

  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists promo_entries_submitter_id_idx on public.promo_entries(submitter_id);
create index if not exists promo_entries_status_idx on public.promo_entries(status);
create index if not exists promo_entries_category_idx on public.promo_entries(category, category_detail);

-- Approved points, grouped by submitter — this is "the leaderboard" for
-- now. Keyed on submitter_id, which is a phone-derived identity, not a
-- verified account (see header comment) — a "merge submitters" admin action
-- is planned (PRD §4) for when the same person is found under two numbers;
-- until that exists, this view will show them as two separate rows.
create or replace view public.leaderboard as
select
  s.id as submitter_id,
  s.whatsapp_phone,
  s.claimed_name,
  s.claimed_email,
  sum(e.points_awarded) as total_points,
  count(*) as approved_entry_count
from public.promo_entries e
join public.submitters s on s.id = e.submitter_id
where e.status = 'approved'
group by s.id, s.whatsapp_phone, s.claimed_name, s.claimed_email
order by total_points desc;

-- RLS on, no policies — everything here is written/read via the service
-- role key only (the bot, and later the admin webapp's server side), never
-- exposed to a public anon key. No public.* policies are missing by
-- mistake; this is the intended locked-down default.
alter table public.category_points enable row level security;
alter table public.submitters enable row level security;
alter table public.promo_entries enable row level security;

-- Storage bucket for screenshots. Private (public = false) — the bot
-- uploads via the service role key, and any admin-facing image display
-- should go through a short-lived signed URL, never a public link, since
-- these are submitters' personal screenshots.
insert into storage.buckets (id, name, public)
values ('promo-screenshots', 'promo-screenshots', false)
on conflict (id) do nothing;
