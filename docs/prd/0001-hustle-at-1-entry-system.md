# PRD: WhatsApp-based entry system for the "Hustle @1" promo

Status: Draft — for review, not yet built.
Related: `src/promoInfo.ts` (promo copy shown to customers today), official rules at
http://promos.hustleapp.io/promo/hustle-at-1

## 1. Problem

Hustlers currently earn "Hustle @1" points by doing something (signing up, completing
their profile, following a social account, posting content, getting a booking, etc.)
and separately messaging a screenshot to 055 693 7198 to claim it. Today that's a fully
manual process on the receiving end — a person reads every screenshot and figures out
what it's for. We want the WhatsApp bot to take the first pass: receive the screenshot,
classify which category it's claiming, log it for review, and let an admin approve or
reject it from a webapp. Approved entries feed a leaderboard.

## 2. Decisions already made (confirmed with Tee, 2026-09-10)

- **Database**: a new, standalone Supabase project built only for this promo. It will
  **not** contain real Hustler/user accounts — those live in the main Hustleapp app's
  own (separate) database, which this bot has no access to.
- **Categories**: every category in the points table goes through screenshot
  submission and manual admin review — including completed/paid bookings. Nothing is
  auto-credited from system data. Rationale given: admins verify everything anyway.
- **Phone-to-account linkage**: **not guaranteed.** The phone number someone messages
  the bot from may not match the phone/email they registered as a Hustler with in the
  main app. We cannot treat "WhatsApp phone number" as a reliable key to a real
  account.

That third point is the one with the most downstream effect on the design, so it's
worth spelling out: since the promo's Supabase has no real user table to join against,
and the WhatsApp phone isn't guaranteed to match a real account, **identity resolution
has to happen manually, by a human admin**, not automatically by the system. The bot
and database only ever deal in a "claimed identity" (whatever the submitter tells us);
turning that into "this actually is Hustler X in the real app" is on the admin, using
tools outside this system (the main app's own admin panel/user search).

## 3. What the bot collects, concretely

When a customer sends the bot an image, the existing pipeline (`imageAnalyzer.ts` →
Claude vision, same call already used for `[Image the customer sent: ...]`
descriptions) gets extended into a promo-entry classifier. It:

1. Decides whether this looks like a promo-entry screenshot at all (vs. an unrelated
   support photo) — if not, it doesn't touch the promo flow.
2. Picks a category from the points table: signup, profile complete, social follow
   (per platform), content post (#HustleAppTurns1), share, like/comment, or completed
   & paid booking.
3. Extracts whatever identifying text is visible (a name, handle, or booking
   reference, if shown).

Since we can't trust phone-as-identity, resolved 2026-09-10: **whatever identity text
is printed on the screenshot is the primary signal**, extracted by the same vision
call that classifies the category — most in-app screens (profile, posts, comments,
shares) show the logged-in user's own name somewhere, so this adds zero extra friction
for the submitter in the common case. Only when the vision model can't find any
legible identity text (or the category's screenshot doesn't naturally show one — see
below) does the bot fall back to asking once, then remembers the answer for that phone
going forward so it isn't asked again on later submissions.

Confirmed 2026-09-10: the **profile-completion** screenshot specifically shows both
name *and* email. Email is the meaningfully stronger of the two — names collide across
real people far more often than emails do, so when an email is visible it should be
treated as the primary key for the admin's manual account search, with name as a
secondary check. (It's also the natural hook for a future automated lookup: once the
main app's backend has a real API — `appApi.ts` is currently fully mocked, see the
earlier research — an email-based account search is a far more reliable thing to
automate than a name search would ever be. Not building that now, just noting it's
where this is headed.) Other categories' screenshots (a follow, a like, a comment)
typically only carry a name/handle, not an email, so email won't always be available —
extract it when present, don't require it.

This is a convenience, not a verification mechanism, and it's worth being precise
about why: a name printed in a screenshot is a claim, not proof — it's no more secure
than the submitter typing their name in chat, since a screenshot of someone else's
profile prints someone else's name just as legibly. The actual anti-spoof backstop is
the duplicate-image-hash check in §7 (the same screenshot reused across two different
phones is the real tell) plus the admin's own manual lookup in the main app, not the
presence of a name. Names also aren't unique — if two real Hustlers share a name, the
admin needs a secondary distinguishing detail (a phone number visible in the
screenshot, registration date, location) to pick the right one; expect "found more
than one match" as a normal review case.

One category is a known weak spot for this: a **social follow** screenshot
("Following" shown on Hustleapp's own account page) shows the account being followed,
not necessarily the follower's own name, unless they specifically screenshot their own
profile instead. Worth a one-line nudge in the bot's prompt for that category asking
them to make sure their name/handle is visible, rather than assuming it always is.

Either way (extracted or self-reported), the claimed name plus the WhatsApp sender's
phone are both stored — neither is treated as verified on its own; together they're
what the admin uses to go find the real account.

For the **booking** category specifically, there's a cheaper verification path already
available: this bot already logs booking events (`logRequestEvent` in
`googleSheet.ts`, visible in the dashboard's Requests tab) for jobs booked through
Hustleapp's own flow. If the submitter gives a request reference, the admin can
cross-check it against real logged data this system already has — no new
infrastructure needed for that one category, just a prompt asking for the reference
and a link/lookup shown next to the entry in the review queue.

## 4. Data model (new Supabase project)

```
submitters
  id (pk)
  whatsapp_phone       -- from the bot, always present
  claimed_name         -- name to use for this phone going forward — backfilled from
                        -- the first entry's ai_extracted_name if present, else asked
                        -- once and stored here so later entries don't re-ask
  claimed_email        -- same idea, backfilled from ai_extracted_email when a
                        -- profile-completion screenshot (or any other) reveals one —
                        -- the stronger of the two keys once we have it (see below)
  created_at

promo_entries
  id (pk)
  submitter_id (fk -> submitters)
  category            -- enum: signup | profile_complete | social_follow | content_post
                       --       | share | like_comment | booking
  category_detail     -- e.g. which platform followed, which post
  screenshot_url       -- Supabase Storage, NOT the WhatsApp media ID/URL (see §6)
  ai_suggested_category
  ai_confidence
  ai_extracted_name    -- name/handle the vision model found in the image, if any —
                        -- kept per-entry (not just on submitters) so the admin can see
                        -- whether THIS screenshot matches the claimed identity or not
  ai_extracted_email    -- email the vision model found (reliably present on
                        -- profile-completion screenshots per §3; usually absent on
                        -- follow/like/comment ones) — same per-entry reasoning as name
  booking_reference     -- optional, only for category = booking
  status               -- pending | approved | rejected
  points_awarded       -- set on approval, from a category→points lookup, editable
  fraud_flags          -- jsonb array, see §7
  reviewed_by
  reviewed_at
  created_at

points_ledger  (one row per awarded entry — or just query promo_entries where
                status = 'approved' directly; a separate ledger only earns its
                keep if points ever need to be awarded outside of entry review,
                e.g. a manual admin adjustment — worth deciding once building)

leaderboard   -- a view: SUM(points_awarded) GROUP BY submitter_id,
                 WHERE status = 'approved', ordered desc
```

Open question worth flagging now rather than at build time: the leaderboard will be
keyed on `submitter_id`, which is really "whoever the bot has been talking to on this
phone," not a verified Hustler. If the same person messages from two different phones,
they'll show up as two separate leaderboard entries unless an admin manually merges
them. Given everything's manually reviewed anyway, a "merge submitters" action in the
webapp is cheap to add and worth including in scope rather than treating as a later
fix.

## 5. Admin review flow (webapp)

- Queue of `pending` entries, screenshot thumbnail, AI-suggested category + confidence,
  claimed identity, fraud flags (see §7), and for bookings, the cross-referenced
  request lookup if a reference was given.
- Actions: approve (optionally overriding category/points), reject (with a reason),
  merge submitters.
- Approving computes `points_awarded` from category (editable — some categories like
  content posts are "+15/week," so the admin may need to confirm this is a new week's
  post, not a repeat).

## 6. Problems to solve before/during build

- **Media persistence**: WhatsApp media URLs are short-lived and the media ID itself
  isn't retained indefinitely on Meta's side. The screenshot bytes must be downloaded
  and written to Supabase Storage at receipt time, not left as a WhatsApp media
  reference to fetch later when an admin actually reviews it (could be days later).
- **Vision misclassification**: expect a real error rate on category detection,
  cropped/blurry/wrong-platform screenshots, and unrelated photos being sent to this
  flow by mistake. The AI's output is a suggestion for the queue, never an
  auto-approval — this is already the plan, just noting it as a hard requirement, not
  a nice-to-have.
- **Booking category is the highest fraud risk now.** Since it's going through
  screenshots like everything else (per the decision above) instead of being
  system-derived, and it's the highest-value, uncapped category, it's the one most
  worth someone trying to fake (screenshot someone else's completed job, or an old one
  reused). The booking-reference cross-check in §3 is the mitigation; it should be
  treated as required for this category, not optional.
- **No real account table to dedupe against**: two different `submitter_id`s (two
  phone numbers) can both claim to be "Kwame Mensah" — the system can't tell them
  apart. This is explicitly punted to human review per the decisions above; just
  making sure that's an accepted tradeoff, not an oversight.

## 7. Fraud/scam flagging

Computed automatically, shown to the admin, never used to auto-reject:

- **Duplicate image detection** — perceptual hash (pHash/dHash, not exact byte match;
  WhatsApp recompresses images) computed on every screenshot. Any match against a
  prior entry gets flagged, with a link to the earlier entry. Dedup rule differs by
  category: `signup`/`profile_complete` are one-time — any repeat hash is suspicious
  regardless of submitter. `content_post`/`booking` legitimately recur — only flag an
  exact hash repeat within the category's natural period (e.g. same week for content
  posts).
- **Claimed-identity mismatch** — if an entry's `ai_extracted_email` doesn't match the
  submitter's stored `claimed_email` (when both are present), flag it — this is the
  higher-confidence version of the check, since emails collide far less than names.
  Fall back to comparing `ai_extracted_name` vs. `claimed_name` when no email is
  available on either side (e.g. two entries from the same phone are both
  follow/comment screenshots). Either way, this is less "verify this is really them"
  (neither signal alone can do that) and more "does this look consistent with what the
  same phone has claimed before" — a phone that submitted a profile screenshot for
  "Ama Owusu, ama@..." and then a booking screenshot under a different name/email is
  worth a second look.
- **Velocity** — many entries from one phone in a short window, or the same image
  hash appearing across multiple different phones same-day.
- Not feasible with what WhatsApp's API exposes: EXIF/timestamp checks (routinely
  stripped/rewritten) and IP/device fingerprinting (no device signal available through
  the Cloud API at all).

## 8. Out of scope for v1

- Automatic point crediting for any category (everything is manual-approve per the
  decision above).
- A real link between `submitters` and actual Hustleapp accounts — that requires the
  main app team to expose something (see §9).
- Rewriting `appApi.ts`'s mocks — unrelated to this feature, not required to build it.

## 9. Dependencies / what's needed before building

- A Supabase project (new, per the decision above) — project URL + service role key
  for the bot, and a scoped key for the webapp's review UI.
- Where does the review UI live — a new page in the existing `dashboard/` (Express +
  vanilla JS, already has an "Alerts"/"Requests"-style tab pattern to extend) or a
  separate app? Given `dashboard/` already has the tab/nav pattern and CSV/PDF export
  helpers that could reuse for exporting entries, extending it is the lower-effort
  path — worth confirming that's acceptable before assuming it.
- Confirm the exact points-per-category values live in one place. Right now they only
  exist as prose in `src/promoInfo.ts` (for the bot's own FAQ answers) — the entry
  system needs the same numbers as actual data (a `category → points` lookup), so
  either the bot's promo copy should be generated from that lookup, or the two need to
  be kept in sync by hand. Worth deciding now rather than letting them drift.

## 10. Rough phasing

1. Supabase schema + Storage bucket, bot downloads/classifies/logs an entry (no admin
   UI yet — verify end-to-end via direct DB queries).
2. Admin review queue in `dashboard/` — list, approve/reject, points override.
3. Fraud flags (image hashing first — highest value, cheapest to build) + booking
   reference cross-check.
4. Leaderboard view/page.
5. Submitter merge tool.
