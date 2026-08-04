# Hustleapp WhatsApp Service

WhatsApp ordering channel. Runs independently of the main app — talks to it
only through the API endpoints listed in `whatsapp-integration-requirements.md`.
Nothing here touches the app's database directly.

## What's in here

- `src/server.ts` — Express webhook (verification + inbound message handling) and a minimal conversation flow
- `src/session.ts` — in-memory per-phone-number session state (swap for Redis/DB later)
- `src/appApi.ts` — client for the main backend's endpoints, currently **mocked** so you can build without waiting on the app dev team

## Setup: Meta Business Manager (do this first, no code needed)

1. Go to business.facebook.com and create/use a Business account.
2. In Meta for Developers, create an app → add the "WhatsApp" product.
3. Under WhatsApp → API Setup, you'll get a temporary access token and a test phone number — enough to build with immediately.
4. Note down: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`.
5. Pick any random string yourself for `WHATSAPP_VERIFY_TOKEN` — you choose this, Meta doesn't give it to you.
6. Later, for production: verify your real business and request a permanent token + real phone number (this review step can take a few days, so start it early even before your integration is finished).

## Local setup

```bash
cp .env.example .env
# fill in the values from Meta Business Manager above
npm install
npm run dev
```

Server starts on `http://localhost:3000`. The webhook endpoints are:
- `GET /webhook` — verification handshake (Meta calls this once when you register the webhook URL)
- `POST /webhook` — receives inbound messages

## Exposing localhost to Meta

Meta needs a public HTTPS URL to send webhooks to. For local development, use a tunnel:

```bash
npx ngrok http 3000
```

Take the `https://...ngrok-free.app` URL, append `/webhook`, and register it in
Meta for Developers → WhatsApp → Configuration → Webhook, along with your
`WHATSAPP_VERIFY_TOKEN`.

## Current state

The conversation flow in `handleMessage()` is intentionally basic —
keyword matching, not real NLU. It exists to prove the session +
backend-call wiring works end to end. Two directions to take it further,
not mutually exclusive:

1. Replace the matching logic with an LLM call for freeform intent parsing.
2. Replace/extend with WhatsApp interactive lists or Flows for a more
   guided, deterministic ordering experience.

All backend calls (`appApi.ts`) are mocked. Swap in real `fetch()` calls
to `APP_API_BASE_URL` once the app dev team delivers the endpoints — no
other file needs to change.

## Testing without a real phone

You can simulate an inbound message by POSTing to `/webhook` directly with
a payload shaped like WhatsApp's actual webhook format (see Meta's docs for
the exact schema) — useful for testing the conversation logic before you
have real WhatsApp round-tripping.
