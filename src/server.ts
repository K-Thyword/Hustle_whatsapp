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

// A photo, video, or document a customer attaches while describing their
// job — forwarded to agents as-is (by media ID) alongside the booking
// summary, so no separate file storage is needed for this interim setup.
export interface MediaAttachment {
  id: string;
  type: "image" | "video" | "document";
}

// --- 2. Inbound message handler ---
app.post("/webhook", async (req: Request, res: Response) => {
  // Always 200 quickly — WhatsApp retries aggressively on non-200s.
  res.sendStatus(200);

  const entry = req.body?.entry?.[0];
  const change = entry?.changes?.[0]?.value;
  const message = change?.messages?.[0];
  if (!message) return; // status updates, etc. — ignore for now

  const from: string = message.from; // phone number, e.g. "233241234567"

  let text: string = message.text?.body?.trim() ?? "";
  let media: MediaAttachment | undefined;

  if (message.type === "image" && message.image?.id) {
    media = { id: message.image.id, type: "image" };
    text = (message.image.caption ?? "").trim();
  } else if (message.type === "video" && message.video?.id) {
    media = { id: message.video.id, type: "video" };
    text = (message.video.caption ?? "").trim();
  } else if (message.type === "document" && message.document?.id) {
    media = { id: message.document.id, type: "document" };
    text = (message.document.caption ?? "").trim();
  }

  console.log(`Inbound from ${from}: ${text}${media ? ` [attached ${media.type}]` : ""}`);

  try {
    await handleMessage(from, text, media);
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
async function handleMessage(phone: string, text: string, media?: MediaAttachment) {
  const session = getSession(phone);
  const lower = text.toLowerCase();

  // A customer can attach a photo/video/document at any point — save it
  // against their session so it can be forwarded to agents with the rest
  // of the booking. If it arrived with no caption text, acknowledge it and
  // wait for their next message rather than advancing the flow with "".
  if (media) {
    const existing = (session.data.attachments as MediaAttachment[] | undefined) ?? [];
    updateSession(phone, { data: { attachments: [...existing, media] } });

    if (!text) {
      await sendMessage(
        phone,
        "Got it, thanks for the photo — I've attached it to your request. Go ahead and continue whenever you're ready."
      );
      return;
    }
  }

  // Lets a customer break out of "escalated" mode and start fresh, instead
  // of being stuck getting the same "someone will be with you" line forever
  // if an agent hasn't replied yet.
  const RESTART_TRIGGERS = ["new request", "start over", "restart", "book again", "new booking"];

  if (session.stage !== "escalated" && ESCALATION_TRIGGERS.some((t) => lower.includes(t))) {
    await sendMessage(
      phone,
      "Sure thing — I'm looping in one of our team members now. Someone will be with you here shortly. (If you'd like to start a new request in the meantime, just say 'new request'.)"
    );
    await notifyAgents(`Customer ${phone} asked to speak with an agent.\nTheir message: "${text}"`);
    updateSession(phone, { stage: "escalated" });
    return;
  }

  if (session.stage === "escalated") {
    if (RESTART_TRIGGERS.some((t) => lower.includes(t))) {
      await sendMessage(phone, "No problem, let's get you sorted. Would you like this done on a specific date, or right away?\n\nJust reply 'schedule' or 'instant'.");
      updateSession(phone, { stage: "awaiting_mode" });
      return;
    }
    await sendMessage(phone, "Thanks for your patience — our team's been notified and will jump in here shortly. (Say 'new request' if you'd like to start something new while you wait.)");
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
      "Hi there, thanks for reaching out to Hustleapp! Would you like this done on a specific date, or do you need it handled right away?\n\nJust reply 'schedule' or 'instant' and we'll take it from there."
    );
    updateSession(phone, { stage: "awaiting_mode" });
    return;
  }

  if (session.stage === "awaiting_mode") {
    const mode: BookingMode = lower.includes("instant") ? "instant" : "standard";
    await sendMessage(phone, "Great — what kind of service do you need? For example: plumber, electrician, hairdresser, accountant, tutor, or anything along those lines.");
    updateSession(phone, { stage: "awaiting_service_type", data: { mode } });
    return;
  }

  if (session.stage === "awaiting_service_type") {
    await sendMessage(phone, "Got it. Which area or location is this for?");
    updateSession(phone, { stage: "awaiting_location", data: { serviceType: text } });
    return;
  }

  if (session.stage === "awaiting_location") {
    const mode = session.data.mode as BookingMode;
    if (mode === "standard") {
      await sendMessage(phone, "And what date would you like this done?");
      updateSession(phone, { stage: "awaiting_date", data: { location: text } });
    } else {
      await sendMessage(phone, "Thanks — now tell me a bit more about what you need done. You're welcome to send a photo or video too if that helps explain it.");
      updateSession(phone, { stage: "awaiting_description", data: { location: text } });
    }
    return;
  }

  if (session.stage === "awaiting_date") {
    await sendMessage(phone, "Thanks — now tell me a bit more about what you need done. You're welcome to send a photo or video too if that helps explain it.");
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
      `Here's what I've got:\n${summaryLines.join("\n")}\n\nDoes that look right? Reply 'yes' to send it off, or 'no' if you'd like to start over.`
    );
    updateSession(phone, { stage: "awaiting_confirmation", data: { description: text } });
    return;
  }

  if (session.stage === "awaiting_confirmation") {
    if (!lower.includes("yes")) {
      await sendMessage(phone, "No worries, let's start over. Reply 'schedule' or 'instant' whenever you're ready.");
      updateSession(phone, { stage: "greeting" });
      return;
    }

    const user = await findOrCreateUserByPhone(phone);
    const mode = session.data.mode as BookingMode;
    const attachments = (session.data.attachments as MediaAttachment[] | undefined) ?? [];
    const result = await submitBookingRequest({
      userId: user.id,
      mode,
      serviceType: session.data.serviceType as string,
      location: session.data.location as string,
      dateWanted: session.data.dateWanted as string | undefined,
      description: session.data.description as string,
      channel: "whatsapp",
      attachmentCount: attachments.length,
    });

    const turnaround =
      mode === "instant"
        ? "usually a few minutes up to about an hour — we'll keep you posted if it's taking a bit longer"
        : "we'll get back to you well ahead of your requested date";

    await sendMessage(
      phone,
      `All set! Your reference number is ${result.requestId}. One of our agents will now get to work finding you a provider — ${turnaround}.\n\nJust a heads up: you'll only pay once you're matched, and that payment is held safely until the job's done.`
    );

    await notifyAgents(
      `New booking request (${mode})\n` +
        `Reference: ${result.requestId}\n` +
        `Customer: ${phone}\n` +
        `Service: ${session.data.serviceType}\n` +
        `Location: ${session.data.location}\n` +
        (mode === "standard" ? `Date: ${session.data.dateWanted}\n` : "") +
        `Details: ${session.data.description}` +
        (attachments.length ? `\nAttachments: ${attachments.length} (forwarded below)` : "")
    );

    // Forward each attached photo/video/document straight to the agents so
    // they can see exactly what the customer sent, no separate storage needed.
    for (const attachment of attachments) {
      for (const number of AGENT_NOTIFY_NUMBERS) {
        await sendMedia(number, attachment);
      }
    }

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

// Forwards a photo/video/document a customer already sent us, by its
// WhatsApp media ID, straight to another number (an agent). No download or
// re-upload needed — WhatsApp hosts the file, we just reference it again.
async function sendMedia(to: string, media: MediaAttachment) {
  const hasRealCredentials =
    process.env.WHATSAPP_ACCESS_TOKEN &&
    process.env.WHATSAPP_ACCESS_TOKEN !== "from-meta-business-manager";

  if (!hasRealCredentials) {
    console.log(`[DRY RUN — would forward ${media.type} (${media.id}) to ${to}]`);
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
      type: media.type,
      [media.type]: { id: media.id },
    }),
  });

  if (!res.ok) {
    console.error("Failed to forward media:", await res.text());
  }
}

app.listen(PORT, () => {
  console.log(`WhatsApp service listening on port ${PORT}`);
});
