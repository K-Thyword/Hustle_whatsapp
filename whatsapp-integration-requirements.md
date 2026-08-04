# WhatsApp Ordering Channel — Backend Integration Requirements

**From:** Tee (WhatsApp channel)
**To:** App backend team
**Date:** August 4, 2026
**Status:** Requesting review + estimate

## Summary

Hustleapp is adding WhatsApp as a second order-taking channel alongside the mobile app. I'm building and owning the WhatsApp side (webhook, conversation handling, message/flow logic). To do that without touching the app's database directly, I need a small set of API endpoints and data additions from the backend. This doc lists exactly what's needed.

## Ownership boundary

- **I own:** WhatsApp webhook, conversation/session state, intent handling (AI or structured flows), all WhatsApp-side UX.
- **Backend team owns:** the endpoints below, and the app's database/schema as it is today.
- **No direct DB access requested.** Everything goes through API calls, same as the mobile app does today.

## Endpoints needed

### 1. Provider availability lookup
`GET /providers/available`
Params: service type, location, time window (whatever filters the app already uses internally)
Returns: list of currently available providers with whatever fields the WhatsApp flow needs to display (name, ETA, price if applicable)

*If this already exists as an internal method used by the app's own availability screen, I likely just need it exposed as a callable endpoint rather than built from scratch.*

### 2. User lookup / creation by phone number
`GET /users/by-phone?phone=...`
`POST /users` (fallback if no account exists yet)
WhatsApp only gives me a phone number, not an app login — I need a way to match that to an existing Hustleapp account, or create a lightweight one if none exists.

### 3. Order creation
`POST /orders`
Needs a `source` or `channel` field (e.g. `"whatsapp"`) so these orders are distinguishable from app orders in reporting, support, and ops tooling.
Returns: order ID + confirmation details I can relay back into the chat.

### 4. Order status lookup
`GET /orders/{id}/status`
For pushing status updates back into WhatsApp (e.g. "provider accepted," "on the way").

## Data additions (small, additive — no restructuring)

- `source` / `channel` field on the `orders` table (or equivalent)
- A way to associate a WhatsApp phone number with a user record (existing field or new mapping table — backend team's call)

## Non-functional asks

- Staging/sandbox API credentials to build and test against before going live
- Any existing API docs (even internal/informal) for the endpoints above
- A point of contact for questions as I build

## Timeline

Happy to align on estimate/priority in a short call — flagging this now so it can be scoped alongside other backend work.

## Open questions for backend team

1. Do endpoints 1–4 already exist internally in some form, or do all need to be built new?
2. Any existing auth pattern I should use for these calls (API key, service token, etc.)?
3. Any constraints on adding the `source` field to orders, or a preferred way to tag channel-of-origin?
