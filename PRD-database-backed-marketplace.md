# PRD: Database-Backed Provider Marketplace & Accounts

**Owner:** Tee (WhatsApp channel)
**Status:** Draft — for review before backend scoping
**Depends on:** Hustleapp backend database connection (not yet live)
**Related docs:** `whatsapp-integration-requirements.md` (Aug 4, 2026 — written under the old ticket-only model; this PRD supersedes/extends its endpoint list, see Requirements below)

## Problem Statement

The WhatsApp bot currently runs on a pure request/ticket model: a customer submits a booking, and a human agent manually finds and confirms a provider outside the bot entirely (`appApi.ts` is fully mocked and explicitly documents "there is no live/real-time list of available providers"). This works, but it caps growth — every booking needs a human in the loop, customers can't see who they're getting or vet them before booking, providers have no account or self-service path, and nothing persists across conversations except an ephemeral session. Once the Hustleapp database is connected, the bot should be able to do meaningfully more of this itself: create real accounts, show customers real provider profiles, let customers book directly, and support rescheduling — while keeping the parts that already work (FAQ, live-agent escalation, intake, cancellation) unchanged.

This also affects both regions: Ghana (live) and Bahamas (planned) will share this same backend and account system once built.

## Goals

- Replace agent-mediated provider matching with customer-facing provider discovery for the majority of bookings, reducing time-to-match and agent manual workload.
- Give every customer and provider a persistent account, so booking history, ratings, and profile data survive across conversations and devices.
- Let customers make an informed choice (ratings, reviews, qualifications, availability) before booking, rather than being told after the fact who they got.
- Support self-service rescheduling and cancellation against real booking/calendar data, cutting down on agent-handled schedule changes.
- Keep everything that currently works (FAQ, escalation, ticket intake as a fallback, cancellation) fully functional throughout the transition — this is additive, not a rewrite.

## Non-Goals

- **Rebuilding FAQ, live-agent escalation, AI date parsing, or the marketing/reminder features.** These already work and aren't touched by this PRD.
- **Real-time provider location tracking or live ETA ("provider is 5 min away").** Valuable eventually, but a separate initiative requiring location data infrastructure this PRD doesn't cover.
- **In-app payment processing (this PRD only covers payment *status tracking*, not moving money).** Actual mobile money integration is its own project with its own compliance surface.
- **Provider onboarding/vetting workflow (background checks, ID verification process itself).** This PRD assumes providers arrive already vetted by the business; it only covers displaying a "verified" badge once that's true, not building the vetting pipeline.
- **A general-purpose admin dashboard.** Any reporting/ops tooling that reads this data is a separate, adjacent project.

## User Stories

**Customer**
- As a customer, I want to see a short explanation of what happens at each step of booking, so I understand why I'm being asked for information and don't drop off mid-flow.
- As a customer, I want to browse available providers for my service type and area, so I can pick based on rating and experience instead of being assigned someone.
- As a customer, I want to see a provider's rating, review summary, and qualifications before booking them, so I can make an informed choice.
- As a customer, I want to confirm a booking directly with my chosen provider, so I don't have to wait on an agent to manually match me.
- As a customer, I want to reschedule an existing booking to a new date/time without cancelling and starting over, so changing plans doesn't cost me my place in the queue.
- As a customer, I want a persistent account, so my booking history and details are remembered the next time I message, even from a new conversation.
- As a customer, if no providers are available for what I need, I want the bot to fall back to the current ticket/agent-matching flow, so I'm never stuck with no path forward.

**Service Provider**
- As a service provider, I want an account with my profile (qualifications, service types, service area), so customers can find and evaluate me.
- As a service provider, I want customers to see my rating and reviews, so strong performance translates into more bookings.
- As a service provider, I want to indicate my availability/calendar, so I only get booked when I can actually take the job.

**Internal / Business**
- As Hustleapp, I want provider profile and account data to live in the real backend (not this bot's Redis store), so it's the single source of truth across the app and WhatsApp channel.
- As Hustleapp, I want WhatsApp-originated accounts and bookings tagged by channel, so they're distinguishable in reporting (this was already requested in the Aug 4 doc and still applies).

## Requirements

### Must-Have (P0)

**Account creation & lookup**
- `findOrCreateUserByPhone` in `appApi.ts` wired to real backend endpoints (`GET /users/by-phone`, `POST /users`), replacing the mock.
- New: provider account creation/lookup by phone, same pattern as customer accounts.
- Acceptance: a returning customer's booking history and saved details persist across sessions and app-channel logins, not just within this bot's Redis TTL.

**Provider profile data model & lookup**
- New backend endpoint(s): `GET /providers/search` (filters: service type, location, availability window) returning enough fields to display a short profile (name, rating, review count/summary, qualifications, next available slot).
- New: `GET /providers/{id}` for full profile detail when a customer asks to see more before booking.
- Acceptance: given a service type and location with at least one matching provider, the bot can present a ranked list of real (non-mocked) options.

**Direct booking flow**
- Extend `submitBookingRequest` (or add a new `confirmBookingWithProvider`) so a customer choosing a specific provider creates a real, provider-linked booking rather than an unassigned ticket.
- Acceptance: given a customer selects a provider from the list, a booking is created with that provider attached, and both customer and provider are notified — no agent action required.

**Graceful fallback**
- If `GET /providers/search` returns zero results (or the backend call fails), fall back to today's ticket flow (`submitBookingRequest` unassigned, agent matches manually) rather than dead-ending the conversation.
- Acceptance: a service type/location combo with no available providers still results in a submitted request, same as today.

### Nice-to-Have (P1)

- **Rescheduling**: new backend endpoint (`PATCH /bookings/{id}/reschedule` or equivalent) plus a WhatsApp flow that reuses the existing date-parsing/confirmation logic already built for booking. Falls back to "agent will help you reschedule" if the endpoint isn't available yet.
- **Onboarding step-explanation copy**: a one-line "why we're asking" note added to each booking-flow prompt. Pure copy/UX change, no backend dependency — can ship independently of everything else in this PRD.
- **AI-assistive booking recommendations**: once real provider data exists, extend the existing AI service-type resolution to also suggest a best-match provider (based on rating + availability), not just resolve the service type.
- **Real appointment-based reminders**: once bookings carry a confirmed date/time from real data, auto-generate a reminder (reusing the existing customer-reminder infrastructure) instead of requiring the customer to set one manually.
- **Fallback/backup provider offer**: if a customer's first-choice provider becomes unavailable before confirmation, automatically offer the next-best match instead of dead-ending.

### Future Considerations (P2)

- **Provider self-service** (accept/decline incoming jobs, mark a job complete, manage their own calendar) directly via WhatsApp, replacing the current fixed agent-notify-list model. Bigger scope — likely its own PRD once provider accounts exist, but this PRD's data model should be built with this in mind (provider accounts, not just profiles) so it isn't a rearchitecture later.
- **Payment/mobile money status tracking** per booking (paid/unpaid/deposit), with reminders on outstanding payment. Relevant for both Ghana (MTN MoMo) and Bahamas.
- **Verification/trust badges** on provider profiles (ID-verified, background-checked), once the vetting pipeline (non-goal above) exists to back it.

## Backend API Needs (addendum to Aug 4 requirements doc)

The original `whatsapp-integration-requirements.md` assumed the ticket-only model and only covered user lookup, order creation/status, and a provider-availability lookup already scoped narrowly. This PRD needs, additionally:

- Provider account creation/lookup by phone (mirrors the existing user endpoint ask)
- Provider profile read (`GET /providers/{id}`) with ratings, review summary, qualifications, service area, availability
- Provider search/filter (`GET /providers/search`) — this may already be endpoint #1 from the original doc if it's extended to return the richer profile fields above, rather than a separate endpoint
- Booking-to-provider linkage on creation (extends `POST /orders`/`POST /booking-requests`)
- Reschedule endpoint (P1)
- All of the above tagged with `channel: "whatsapp"` per the original doc's ask, so WhatsApp-originated accounts/bookings/providers stay distinguishable in reporting

Recommend sending this as a follow-up to the backend team rather than a full re-send — the ownership boundary and auth/staging asks from the original doc still stand.

## Success Metrics

Targets below are placeholders — need real numbers from the business side (see Open Questions).

**Leading indicators**
- % of bookings completed via direct customer-provider selection vs. falling back to agent-matched ticket (target: TBD)
- Time from booking start to confirmed provider (target: reduce vs. current agent-matching turnaround — need current baseline)
- % of customers who view a provider profile before booking, once available

**Lagging indicators**
- Reduction in agent manual-matching workload (tickets requiring agent "matched" action)
- Repeat booking rate for customers with persistent accounts vs. historical session-only behavior
- Provider rating/review volume growth over time

## Open Questions

- **(Stakeholder)** What are the actual success metric targets? Placeholders above need real numbers.
- **(Stakeholder)** Is there a hard timeline/deadline for this, or is it scoped whenever backend bandwidth allows?
- **(Stakeholder)** Should provider self-service (P2) and self-serve customer discovery (P0 here) launch in Ghana too, or start Bahamas-only since Bahamas is the region explicitly requiring provider registration? Building the data model region-agnostically either way, but the *exposed WhatsApp flow* could differ by region.
- **(Engineering/backend team)** Do any of the new endpoints above already exist internally (e.g., if there's already an app-side "browse providers" screen), or do all need to be built new?
- **(Business)** What defines a provider as "available" for search/filter purposes — real-time calendar, or a simpler "accepting jobs" toggle? Affects how much calendar infrastructure is actually needed for P0.

## Timeline Considerations

- Hard-blocked on the backend database/API connection — nothing in Must-Have can start against real data until that lands, though the WhatsApp-side flow (prompts, list rendering, confirmation UX) can be built and tested against updated mocks in `appApi.ts` in the meantime, same pattern used for the current ticket flow.
- Suggested phasing if this is too large for one push:
  1. Accounts + provider profile data model + search (P0 foundation)
  2. Direct booking flow + fallback (P0, depends on #1)
  3. Rescheduling + onboarding copy + AI recommendations (P1, can run in parallel with #2 once #1 lands)
  4. Provider self-service + payment tracking + trust badges (P2, own initiative)
