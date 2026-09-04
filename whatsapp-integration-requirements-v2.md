# WhatsApp Ordering Channel — Backend Integration Requirements (v2)

**From:** Tee (WhatsApp channel)
**To:** App backend team
**Date:** August 12, 2026
**Status:** Requesting review + estimate
**Supersedes/extends:** `whatsapp-integration-requirements.md` (Aug 4, 2026) — that doc assumed a pure ticket model with no live provider list. This version adds what's needed to let customers browse and book real providers directly. Endpoints #2–4 from the original doc are unchanged and still needed as originally scoped; this is additive.

## What changed and why

The original doc assumed a human agent always manually matches a provider after a booking is submitted. We now want the bot to be able to show a customer real provider options (rating, qualifications, availability) and let them book directly — falling back to the original agent-matched flow whenever no providers are available. Full product context is in `PRD-database-backed-marketplace.md` if useful; this doc is just the concrete build list.

## Ownership boundary (unchanged)

- **I own:** WhatsApp webhook, conversation/session state, intent handling, all WhatsApp-side UX.
- **Backend team owns:** the endpoints below and the app's database/schema.
- **No direct DB access requested** — same as the original doc.

## First question before anything else

**Does a provider profile/account concept already exist in the app's database** (used by the mobile app's own booking/matching), or would this be new? This determines whether most of what's below is "expose an existing model" or "build a new one" — big difference in scope, and probably worth a quick answer before estimating the rest.

## Endpoints needed

### P0 — blocks the core direct-booking flow

**1. Provider account lookup/creation by phone**
`GET /providers/by-phone?phone=...`
`POST /providers` (fallback if none exists)
Mirrors the customer user-lookup endpoint from the original doc (#2 there), same pattern, for providers instead of customers.

**2. Provider profile read**
`GET /providers/{id}`
Returns: name, service type(s), service area/location, rating (average), review count, a short review summary or a couple of sample review snippets, qualifications, and current availability (or next available slot — see open question below on what "available" means).

**3. Provider search**
`GET /providers/search`
Params: service type, location, availability window (same filters as the original doc's endpoint #1, "provider availability lookup" — **this may just be that same endpoint extended to return the richer profile fields above, rather than a new one.** Flagging so it's not built twice.)
Returns: list of provider summaries (id, name, rating, review count, qualifications short-form, next available slot).

**4. Booking creation with optional provider link**
Extends the original doc's `POST /orders` (endpoint #3): add an optional `providerId` field.
- If `providerId` is present: booking is created already assigned/confirmed to that provider — no agent action needed.
- If `providerId` is omitted: behaves exactly as today — unassigned ticket, agent matches manually. This is the fallback path when search returns nothing, so nothing about the current flow needs to change or break.

**5. Order/booking status lookup** — unchanged, already covered by the original doc's endpoint #4 (`GET /orders/{id}/status`).

### P1 — not blocking, needed soon after

**6. Reschedule**
`PATCH /orders/{id}/reschedule` (or equivalent)
Body: new date/time.
Returns: updated booking confirmation. Until this exists, reschedule requests just route to an agent, same as any other manual change today.

## Data additions

- Everything from the original doc still applies (`source`/`channel` field on orders, phone-to-user mapping).
- New: nullable `providerId` on the orders/bookings table — null means unassigned ticket (today's behavior), populated means directly booked. Backward compatible by design.
- New: provider profile fields — rating aggregate, review count/summary, qualifications, service area, availability — wherever provider records would live (existing table if one exists per the question above, or new).

## Non-functional asks (unchanged from original doc)

- Staging/sandbox credentials to build and test against
- Any existing API docs for the endpoints above
- A point of contact for questions as I build

## Open questions for backend team

1. Does a provider profile/account concept already exist internally (e.g. used by the app's own matching screen), or does all of this need to be built new?
2. What defines a provider as "available" for search purposes — a real-time calendar, or a simpler "currently accepting jobs" toggle? Affects how much calendar work is actually needed for P0.
3. Any constraints on adding a nullable `providerId` to the orders table?
4. Realistic timeline for at least the P0 items (#1–5)? P1 (#6) can wait.
5. Same auth-pattern question as the original doc, if it's still unanswered — API key vs. service token vs. something else.
