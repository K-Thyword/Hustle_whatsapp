import "dotenv/config";
import express, { Request, Response } from "express";
import { getSession, updateSession } from "./session";
import { findOrCreateUserByPhone, submitBookingRequest, BookingMode } from "./appApi";
import { routeIntent } from "./intentRouter";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// Any of these, anywhere in a message, hands the conversation to a human
// agent — matches the Hustleapp policy that disputes/refunds and anything
// the bot can't handle are resolved by a person, not automatically.
const ESCALATION_TRIGGERS = [
  "agent",
  "human",
  "more help",
  "help",
  "manager",
  "sales representative",
  "customer service",
];

// Interim measure while there's no real backend to receive booking
// requests: notify these agent numbers directly over WhatsApp whenever a
// request is submitted, so a human actually sees it. Comma-separated in
// .env, digits only (no "+", no spaces) — e.g. "233556963137,233556937198".
// Replace with a real notification path (backend webhook, dashboard, etc.)
// once one exists — nothing else in this file needs to change.
const AGENT_NOTIFY_NUMBERS = (process.env.AGENT_NOTIFY_NUMBERS || "")
  .split(",")
  .map((n) => n.trim())
  .filter(Boolean);

async function notifyAgents(message: string) {
  for (const number of AGENT_NOTIFY_NUMBERS) {
    await sendMessage(number, message);
  }
}

// --- 1. Webhook verification (Meta calls this once, on setup) ---
app.get("/webhook", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified.");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// --- 2. Inbound message handler ---
app.post("/webhook", async (req: Request, res: Response) => {
  // Always 200 quickly — WhatsApp retries aggressively on non-200s.
  res.sendStatus(200);

  const entry = req.body?.entry?.[0];
  const change = entry?.changes?.[0]?.value;
  const message = change?.messages?.[0];
  if (!message) return; // status updates, etc. — ignore for now

  const from: string = message.from; // phone number, e.g. "233241234567"
  const text: string = message.text?.body?.trim() ?? "";

  console.log(`Inbound from ${from}: ${text}`);

  try {
    await handleMessage(from, text);
  } catch (err) {
    console.error("Error handling message:", err);
  }
});

// --- 3. Conversation logic ---
// Hustleapp connects customers with artisans/professionals — there is no
// live/real-time list of available providers. So this flow collects the
// customer's request details and submits them as a booking request that a
// human agent works manually, rather than showing a live list to pick from.
//
// Two paths after service type + location are collected:
//   - "standard": also asks for a date, since the job may be scheduled ahead
//   - "instant": skips the date, submitted for agents to find someone ASAP
//
// Escalation to a human can happen from any stage — checked first, always.
async function handleMessage(phone: string, text: string) {
  const session = getSession(phone);
  const lower = text.toLowerCase();

  if (session.stage !== "escalated" && ESCALATION_TRIGGERS.some((t) => lower.includes(t))) {
    await sendMessage(
      phone,
      "Connecting you to a human agent — someone from our team will be with you here shortly."
    );
    updateSession(phone, { stage: "escalated" });
    return;
  }

  if (session.stage === "escalated") {
    await sendMessage(phone, "A human agent has been notified and will respond to you here shortly.");
    return;
  }

  // General questions about the business get answered directly, without
  // derailing the booking intake, at the two earliest stages.
  if (session.stage === "greeting" || session.stage === "awaiting_mode") {
    const routed = await routeIntent(text);
    if (routed.intent === "question" && routed.reply) {
      await sendMessage(phone, routed.reply);
      return;
    }
  }

  if (session.stage === "greeting") {
    await sendMessage(
      phone,
      "Hi! Welcome to Hustleapp. Do you want this done on a specific date, or do you need it instantly (ASAP)?\n\nReply 'schedule' or 'instant'."
    );
    updateSession(phone, { stage: "awaiting_mode" });
    return;
  }

  if (session.stage === "awaiting_mode") {
    const mode: BookingMode = lower.includes("instant") ? "instant" : "standard";
    await sendMessage(phone, "What service do you need? (e.g. plumber, electrician, accountant, tutor...)");
    updateSession(phone, { stage: "awaiting_service_type", data: { mode } });
    return;
  }

  if (session.stage === "awaiting_service_type") {
    await sendMessage(phone, "What location/area is this for?");
    updateSession(phone, { stage: "awaiting_location", data: { serviceType: text } });
    return;
  }

  if (session.stage === "awaiting_location") {
    const mode = session.data.mode as BookingMode;
    if (mode === "standard") {
      await sendMessage(phone, "What date would you like this done?");
      updateSession(phone, { stage: "awaiting_date", data: { location: text } });
    } else {
      await sendMessage(phone, "Please describe what you need done.");
      updateSession(phone, { stage: "awaiting_description", data: { location: text } });
    }
    return;
  }

  if (session.stage === "awaiting_date") {
    await sendMessage(phone, "Please describe what you need done.");
    updateSession(phone, { stage: "awaiting_description", data: { dateWanted: text } });
    return;
  }

  if (session.stage === "awaiting_description") {
    const mode = session.data.mode as BookingMode;
    const serviceType = session.data.serviceType as string;
    const location = session.data.location as string;
    const dateWanted = session.data.dateWanted as string | undefined;

    const summaryLines = [
      `Service: ${serviceType}`,
      `Location: ${location}`,
      ...(mode === "standard" ? [`Date: ${dateWanted}`] : []),
      `Details: ${text}`,
    ];
    await sendMessage(
      phone,
      `Please confirm your request:\n${summaryLines.join("\n")}\n\nReply 'yes' to submit, or 'no' to start over.`
    );
    updateSession(phone, { stage: "awaiting_confirmation", data: { description: text } });
    return;
  }

  if (session.stage === "awaiting_confirmation") {
    if (!lower.includes("yes")) {
      await sendMessage(phone, "No problem — let's start again. Reply 'schedule' or 'instant'.");
      updateSession(phone, { stage: "greeting" });
      return;
    }

    const user = await findOrCreateUserByPhone(phone);
    const mode = session.data.mode as BookingMode;
    const result = await submitBookingRequest({
      userId: user.id,
      mode,
      serviceType: session.data.serviceType as string,
      location: session.data.location as string,
      dateWanted: session.data.dateWanted as string | undefined,
      description: session.data.description as string,
      channel: "whatsapp",
    });

    const turnaround =
      mode === "instant"
        ? "A few minutes up to about an hour — we'll update you if it's taking longer."
        : "We'll confirm your provider ahead of your requested date.";

    await sendMessage(
      phone,
      `Request submitted! Reference: ${result.requestId}\nOne of our agents will now find you a provider. ${turnaround}\n\nPayment happens once you're matched — your money is held in escrow until the job is done.`
    );

    await notifyAgents(
      `New booking request (${mode})\n` +
        `Reference: ${result.requestId}\n` +
        `Customer: ${phone}\n` +
        `Service: ${session.data.serviceType}\n` +
        `Location: ${session.data.location}\n` +
        (mode === "standard" ? `Date: ${session.data.dateWanted}\n` : "") +
        `Details: ${session.data.description}`
    );

    updateSession(phone, { stage: "request_submitted" });
    return;
  }

  // request_submitted or unrecognized — reset for simplicity in this skeleton
  updateSession(phone, { stage: "greeting" });
}

// --- 4. Outbound sender ---
// If real WhatsApp credentials aren't set yet (local testing before Meta
// access is sorted out), just log what would have been sent instead of
// calling the real API and failing. Lets you test the full conversation
// flow today without waiting on anything external.
async function sendMessage(to: string, body: string) {
  const hasRealCredentials =
    process.env.WHATSAPP_ACCESS_TOKEN &&
    process.env.WHATSAPP_ACCESS_TOKEN !== "from-meta-business-manager";

  if (!hasRealCredentials) {
    console.log(`[DRY RUN — would send to ${to}]:\n${body}\n`);
    return;
  }

  const url = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      text: { body },
    }),
  });

  if (!res.ok) {
    console.error("Failed to send message:", await res.text());
  }
}

app.listen(PORT, () => {
  console.log(`WhatsApp service listening on port ${PORT}`);
});
