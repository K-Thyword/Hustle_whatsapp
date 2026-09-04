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

## Visibility: transcripts, alerts, and a weekly review habit

Nobody sees a bot-customer conversation as it happens unless a live chat
gets escalated and claimed — that's a real blind spot, since it means the
only way problems surface is someone happening to notice and screenshot
one. Two things address this, both logged to the Google Sheet (see
`src/googleSheet.ts` for setup):

- **Transcripts tab** — every message a customer sends, and every message
  they receive (scripted bot replies and an agent's relayed live-chat
  replies alike), timestamped per phone number. This is the raw record —
  reading it is still a manual, periodic thing, not something anyone gets
  paged for.
- **Real-time struggle alerts** — if a customer hits 2 or more "the bot
  had to push back on that reply" moments in the same booking (a vague
  answer, a rejected date, a location that didn't make sense), agents get
  a WhatsApp alert once per session: *"Customer might be having trouble
  booking — worth a quick check-in?"* This only catches struggle patterns
  already built into the bot's checks — it won't flag a genuinely new kind
  of confusion the first time it happens. That's what the transcript
  review below is for.
- **Delivery-failure alerts** — separately, if a notification to an agent
  or customer never reaches anyone (WhatsApp window closed and the
  fallback template also failed), that's logged as an `ALERT` row too.

**Standing habit: a weekly pass over the sheet.** Once a week, skim the
Transcripts tab for the last several days — specifically conversations
that ended abruptly, looped, or show a struggle alert — plus any `ALERT`
rows in the event log. The goal isn't to read everything; it's to catch
patterns a single test conversation wouldn't reveal (the same confusing
question tripping up multiple customers, a service type people keep
asking for that isn't supported, a stage where people commonly abandon).
Turn what you find into concrete fixes the same way every fix in this
project has happened so far — bring specific examples, and they get
root-caused and fixed as their own change, not batched into something
vague. This is the realistic version of the bot "getting smarter": a
short, repeatable, human-reviewed cycle backed by real conversation data,
not an autonomous system quietly rewriting its own rules.

## Facebook/Instagram post & ad awareness

Two related but separate things, both backed by the Google Sheet:

- **Ad/post click attribution (automatic)** — when a customer taps "Send
  Message" on a Facebook/Instagram ad or boosted post, WhatsApp attaches a
  `referral` object (headline, body, which post/ad it was) to that first
  message automatically — nothing to set up for this part. The bot's
  opening reply now naturally acknowledges what they clicked on instead of
  a generic greeting, and every click is logged to a **Referrals** tab
  (header row: `Timestamp | Phone | SourceType | Headline | Body |
  SourceURL | CTWA_CLID`) so you can see which posts are actually driving
  conversations.
- **Recent-posts memory (manual)** — for when a customer mentions a post
  with no click involved ("is the discount from your post still on?"),
  there's no automatic signal from Meta, so the bot instead checks a
  **Posts** tab you keep updated yourself (header row: `Date | Platform |
  Summary | Link`) — add a row whenever you post something worth the bot
  knowing about. Read with a 5-minute cache, so a new row shows up on the
  very next customer question, no redeploy needed.

Both tabs are optional — without them, the bot behaves exactly as before,
just without the extra context.

## Testing without a real phone

You can simulate an inbound message by POSTing to `/webhook` directly with
a payload shaped like WhatsApp's actual webhook format (see Meta's docs for
the exact schema) — useful for testing the conversation logic before you
have real WhatsApp round-tripping.
# Hustle_whatsapp
