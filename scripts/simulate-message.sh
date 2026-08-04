#!/bin/bash
# Simulates an inbound WhatsApp message hitting your local webhook,
# without needing real WhatsApp/Meta access. Lets you test the full
# conversation flow (session, provider lookup, order creation) today.
#
# Usage:
#   ./scripts/simulate-message.sh <phone-number> "<message text>"
#
# Example — a full order, one message at a time:
#   ./scripts/simulate-message.sh 233241234567 "hi"
#   ./scripts/simulate-message.sh 233241234567 "delivery"
#   ./scripts/simulate-message.sh 233241234567 "1"
#
# Watch the terminal running `npm run dev` — replies print as
# "[DRY RUN — would send to ...]" since there's no real WhatsApp number yet.

PHONE="${1:-233241234567}"
TEXT="${2:-hi}"

curl -s -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d "{
    \"entry\": [{
      \"changes\": [{
        \"value\": {
          \"messages\": [{
            \"from\": \"${PHONE}\",
            \"text\": { \"body\": \"${TEXT}\" }
          }]
        }
      }]
    }]
  }" > /dev/null

echo "Sent \"${TEXT}\" from ${PHONE} — check the npm run dev terminal for the reply."
