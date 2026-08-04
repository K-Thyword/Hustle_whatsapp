# Zero-to-Shipped: Building the WhatsApp Channel with AI Help

This is your full walkthrough — no assumed knowledge. We'll go phase by
phase; don't skip ahead. After each phase, come back and tell me you're
done (or what went wrong), and I'll take you to the next one.

Your project already exists at:
`~/Desktop/CODING/APPS/hustleapp-whatsapp/`

---

## Phase 0 — Install the tools

You need five things on your computer. Install all five before continuing.

1. **VS Code** — the code editor you'll work in. Download from code.visualstudio.com, run the installer, open it once to confirm it launches.
2. **Node.js** — lets your computer run JavaScript/TypeScript outside a browser, and comes with `npm` (installs packages). Download the **LTS** version from nodejs.org. Run the installer.
3. **Git** — version control (tracks changes, lets you undo mistakes, lets you deploy). Download from git-scm.com. Mac users: it may already be installed — check in step below.
4. **A GitHub account** — free, at github.com. This is where your code lives online and where deployment will pull from later.
5. **ngrok** — temporarily exposes your local computer to the internet so WhatsApp can reach it while you're testing. Download from ngrok.com, sign up free, install it.

You do **not** need to install an AI coding tool separately — you're already using one (this chat). I read, write, and run code directly in your connected folder.

### Verify installs

Open VS Code, then open its built-in terminal: menu **Terminal → New Terminal**. Type each of these, press enter, and check you get a version number back (not "command not found"):

```
node -v
npm -v
git --version
```

Tell me what versions you see, or paste any error, and we move to Phase 1.

---

## Phase 1 — Open the project

1. In VS Code: **File → Open Folder** → select `Desktop/CODING/APPS/hustleapp-whatsapp`.
2. You'll see the files on the left: `src/`, `package.json`, `README.md`, this guide, etc. This is the WhatsApp service I already scaffolded for you.
3. In the terminal (still inside VS Code, now inside this folder), run:

```
npm install
```

This downloads all the code libraries the project depends on (Express, TypeScript, etc.) into a `node_modules` folder. Takes under a minute. If it errors, paste the error here before continuing.

4. Copy the example environment file:

```
cp .env.example .env
```

`.env` holds secrets (API keys) that should never be shared or committed to git — that's already handled, it's listed in `.gitignore`.

Tell me when `npm install` finishes cleanly, then we move to Phase 2.

---

## Phase 2 — Understand what you already have (read-only, no action)

Open these three files in VS Code and skim them — I'll explain what each does, you don't need to fully understand the syntax yet:

- **`src/server.ts`** — the actual WhatsApp service. Receives messages, decides what to reply, calls the backend.
- **`src/session.ts`** — remembers where each conversation is up to (has this person just said hi, or are they mid-order?).
- **`src/appApi.ts`** — talks to the main Hustleapp backend. Currently fake data ("mocked") so we can build without waiting on the other dev team.

No commands to run here. Just read them, ask me anything that's unclear, then tell me you're ready for Phase 3.

---

## Phase 3 — Meta Business Manager (WhatsApp access)

This is account setup, not code — do it in your browser.

1. Go to business.facebook.com → create a Business account if you don't have one (uses your real business details).
2. Go to developers.facebook.com → **My Apps → Create App** → choose "Business" as the type → add the **WhatsApp** product to it.
3. Inside the app, go to **WhatsApp → API Setup**. Meta gives you, for free testing:
   - A temporary access token
   - A test phone number you can send/receive from immediately (no business verification needed yet)
4. Copy four values from that page into your `.env` file (open `.env` in VS Code):
   - `WHATSAPP_ACCESS_TOKEN`
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `WHATSAPP_BUSINESS_ACCOUNT_ID`
5. For `WHATSAPP_VERIFY_TOKEN` — this one you make up yourself, any random string (e.g. `hustleapp-verify-2026`). Meta doesn't give you this; you choose it and enter the same value in both `.env` and Meta's webhook settings later.

Tell me once you have the four values in `.env`, and we move to Phase 4.

---

## Phase 4 — Run it and connect WhatsApp for real

1. In the VS Code terminal, start the service:

```
npm run dev
```

You should see `WhatsApp service listening on port 3000`. Leave this running.

2. Open a **second** terminal (VS Code: the `+` icon in the terminal panel) and run:

```
ngrok http 3000
```

This gives you a public URL like `https://abcd1234.ngrok-free.app`. Leave this running too — both terminals stay open while you test.

3. Back in Meta for Developers → **WhatsApp → Configuration → Webhook**, click Edit, and enter:
   - Callback URL: your ngrok URL + `/webhook` (e.g. `https://abcd1234.ngrok-free.app/webhook`)
   - Verify token: the exact same string you put in `WHATSAPP_VERIFY_TOKEN`
4. Click Verify and Save. If it succeeds, your first terminal (running `npm run dev`) should print "Webhook verified." If it fails, tell me the exact error.
5. Subscribe to the `messages` field on that same page (there's a checkbox/button for it).
6. From your own phone, message the test WhatsApp number Meta gave you. Watch your first terminal — you should see the message logged, and get a reply back on your phone.

This is the real milestone: a message from your actual phone, through WhatsApp's servers, into your own code, and back. Tell me when this works (or paste what breaks), then we move to Phase 5.

---

## Phase 5 — Working with me day to day

From here on, most sessions look like: tell me what you want to change or add, I edit the files directly in this folder, explain what changed, and you re-run `npm run dev` (it auto-reloads on save, so often you just re-test in WhatsApp). Good habits:

- Test after every change, don't stack up five changes before testing.
- If something breaks, paste the exact error — don't paraphrase it.
- Ask "why" whenever a change doesn't make sense to you. You should understand what's shipping, not just approve it blindly.

---

## Phase 6 — Git and GitHub (save your progress properly)

Right now your code only exists on your laptop. Git tracks its history; GitHub backs it up online and is what deployment (Phase 9) pulls from.

```
git init
git add .
git commit -m "Initial WhatsApp service skeleton"
```

Then on github.com, create a new empty repository (no README/license — you already have files), and follow the "push an existing repository" instructions it shows you, which will look like:

```
git remote add origin https://github.com/YOUR-USERNAME/hustleapp-whatsapp.git
git branch -M main
git push -u origin main
```

From now on, after meaningful changes:

```
git add .
git commit -m "short description of what changed"
git push
```

Tell me once this is pushed, then we move to Phase 7.

---

## Phase 7 — Swap in the real backend

Once the app dev team responds to the requirements doc with real endpoints:

1. Give me the actual endpoint URLs, request/response shapes, and how auth works (API key header, etc.).
2. I'll update only `src/appApi.ts` to call the real API instead of returning mock data — nothing else in the project changes, because everything else only ever talks to the functions in that one file.
3. We re-test the same way as Phase 4, this time with real provider/order data.

Nothing to do here yet except forward me what they send back.

---

## Phase 8 — Make the conversation smarter (optional upgrade)

The current flow is basic keyword matching. Two directions, pick based on what you want:

- **LLM-based intent parsing** — I wire in a Claude API call so freeform messages ("need a bike to Osu now") get understood directly, instead of the user having to reply with exact numbers/keywords.
- **WhatsApp Flows / interactive lists** — a more guided, button-driven experience where the user taps rather than types, which is more deterministic and less likely to misfire on an order.

We'll pick this together when you're ready — not required to go live with a basic version first.

---

## Phase 9 — Deploy it (make it run without your laptop)

Your laptop running `npm run dev` isn't a real production setup — it needs to be always-on. Beginner-friendly hosts that deploy straight from GitHub:

- **Railway** (railway.app) — simplest for a small Node service, generous free tier to start.
- **Render** (render.com) — similar, also straightforward.

General steps (I'll walk you through your chosen one specifically when we get here):

1. Connect your GitHub repo to the host.
2. Set the same environment variables from your `.env` in the host's dashboard (never commit `.env` itself).
3. Deploy — you get a permanent public URL, e.g. `https://hustleapp-whatsapp.up.railway.app`.
4. Update Meta's webhook Callback URL to this permanent URL + `/webhook` instead of the ngrok one. ngrok was only ever for local testing.

---

## Phase 10 — Go from test number to real business number

Meta's test number and temporary token are for development only. To actually take real customer orders:

1. In Meta for Developers, complete **Business Verification** (submit real business documents — this can take a few days, worth starting early).
2. Add your real WhatsApp Business phone number (can't be a number already used on personal WhatsApp).
3. Request a permanent access token (not the 24-hour temporary one from Phase 3).
4. Any message you send *first* (not replying to a customer) outside a 24-hour window needs a pre-approved **message template** — submit these in Meta's WhatsApp Manager and wait for approval before relying on them.

---

## Phase 11 — Shipping checklist

Before calling this live:

- [ ] Deployed on a real host, not your laptop
- [ ] Webhook points at the permanent URL, verified successfully
- [ ] Real backend endpoints wired in (Phase 7 done, no more mocks)
- [ ] Business verified, real phone number active
- [ ] Any proactive messages use approved templates
- [ ] You've personally tested a full order start-to-finish on the real number
- [ ] Basic error handling — what happens if the backend is down, or a user sends gibberish
- [ ] Someone (even just you) is watching logs/errors for the first few days after launch

---

**Where we are right now: Phase 0.** Go install the five tools, run the three verify commands, and tell me what you get.
