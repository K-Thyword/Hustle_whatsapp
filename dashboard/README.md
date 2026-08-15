# Hustleapp Dashboard

A read-only ops dashboard over the same Google Sheet the WhatsApp bot logs to. Deployed as its own Railway service, completely separate from the bot's process — a bug or slow request here can never affect the live customer-facing bot.

Six tabs:

- **Overview** — KPI cards + a by-service chart for a selected window (today / 7 days / 30 days).
- **Requests** — every request's current status, grouped from the bot's append-only event log (Sheet1), filterable by status.
- **Alerts** — delivery failures (agent/customer notifications that never actually arrived).
- **Chats** — browse or search every logged conversation (Transcripts tab), same data used for the weekly manual review.
- **Agents** — workload per agent, derived from who claimed each request.
- **Reports** — an AI-written (or, without an Anthropic key, plainly computed) weekly summary, viewable anytime, and (once the WhatsApp variables below are set) sent automatically to every agent in `AGENT_NOTIFY_NUMBERS` every Monday at 8am.

## Local development

```
cd dashboard
npm install
cp .env.example .env   # fill in the values below
npm run dev
```

Visit `http://localhost:3001`.

## Environment variables

| Variable | Where it comes from |
|---|---|
| `ADMIN_DASHBOARD_PASSWORD` | Pick your own — one shared password for you + the 3 agents. |
| `SESSION_SECRET` | Any random string. Generate with `openssl rand -hex 32`. |
| `GOOGLE_SHEETS_ID` | **Same value** as the bot service's env var — copy it over. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | **Same value** as the bot service's env var — copy it over. |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | **Same value** as the bot service's env var — copy it over. |
| `AGENT_NAMES` | **Same value** as the bot service's env var — copy it over. Used to label the Agents tab and "claimed by" column with names instead of raw numbers. |
| `ANTHROPIC_API_KEY` | Optional. **Same value** as the bot service's env var. Without it, Reports still works, just with a plain computed summary instead of an AI-written one. |
| `WHATSAPP_ACCESS_TOKEN` | Optional — for the automatic Monday digest send. **Same value** as the bot service's env var. |
| `WHATSAPP_PHONE_NUMBER_ID` | Optional — same as above. **Same value** as the bot service's env var. |
| `AGENT_NOTIFY_NUMBERS` | Optional — same as above. **Same value** as the bot service's env var (comma-separated, digits only, no `+`). |
| `WEEKLY_DIGEST_TEMPLATE_NAME` | Optional, defaults to `hustle_weekly_digest`. Must exist and be **approved** in Meta Business Manager first — see below. |
| `WEEKLY_DIGEST_TEMPLATE_LANGUAGE` | Optional, defaults to `en_US`. Must exactly match the language you pick when creating the template in Meta. |

Everything except the WhatsApp send is **read from the same Google Sheet the bot already writes to** — nothing new to set up in Google Cloud, just copy values across.

### Setting up the weekly WhatsApp send (optional)

The digest is sent as a WhatsApp **template** message (not a plain message) specifically so it goes out reliably regardless of whether an agent's 24h conversation window happens to be open that Monday morning — templates are the one message type Meta allows outside that window.

1. In Meta Business Manager → WhatsApp Manager → Message Templates, create a new template:
   - Name: `hustle_weekly_digest`
   - Category: **Utility**
   - Language: **English (US)** (this is `en_US` — picking plain "English" gives a different language code and will fail to send, the same gotcha documented in the bot's own README)
   - Body: one variable, e.g. `Hustleapp weekly summary: {{1}}`
2. Submit it for approval (usually takes minutes to a few hours).
3. Once approved, add the 5 variables above (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `AGENT_NOTIFY_NUMBERS`, and the two template ones if you didn't use the defaults) to this service on Railway.
4. On the Reports tab, use the **"Send now"** button to confirm delivery works without waiting for Monday.

## Deploying on Railway (as a second service in the same project)

1. In your existing Railway project (where the bot already runs), click **+ New** → **GitHub Repo** → select the same `hustleapp-whatsapp` repo again. Railway will create a second, independent service from the same repo.
2. On that new service's **Settings** tab, set **Root Directory** to `dashboard`. This tells Railway to build/run only this subfolder, ignoring the bot's code entirely.
3. On the **Variables** tab, add all seven variables from the table above (copy the four shared ones straight from the bot service's Variables tab).
4. Railway will auto-detect `npm run build` and `npm start` from `package.json`. First deploy takes a minute or two.
5. Once deployed, Railway gives this service its own public URL (separate from the bot's). Open it, log in with `ADMIN_DASHBOARD_PASSWORD`, and you're in.

## Notes on what "Agents" and "struggling conversations" currently do and don't show

- **Agents tab**: workload is derived from the `claimed` event's logged detail (the claiming agent's phone number) in Sheet1. An agent who acts on a request without ever explicitly claiming it first won't show — in practice this shouldn't happen, since the bot auto-claims a request the moment an agent takes any action on it.
- **Struggling conversations**: the bot already detects when a customer seems to be having trouble (see the bot's `recordFriction` in `server.ts`) and pings agents directly over WhatsApp in real time — but that alert isn't currently written to the Sheet, so it won't show up as a number anywhere on this dashboard yet (the Overview card for it always reads 0). If that visibility matters, the fix is small: have the bot's `recordFriction` call `logAlert(...)` the same way delivery failures already do, and this dashboard's Alerts tab would pick it up automatically with no dashboard-side change needed.
