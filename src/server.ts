import "dotenv/config";
import express, { Request, Response } from "express";
import {
  getSession,
  updateSession,
  resetForNewRequest,
  addPastBooking,
  appendMessageLog,
  getAllSessions,
  ConversationStage,
  PastBooking,
} from "./session";
import { findOrCreateUserByPhone, submitBookingRequest, BookingMode } from "./appApi";
import { routeIntent } from "./intentRouter";
import { interpretDate } from "./dateInterpreter";

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

// --- Recognizing yes/no, including common emoji ---
// WhatsApp conversations lean on emoji a lot for quick replies — a
// thumbs-up or high-five is exactly as much a "yes" as typing the word.
const AFFIRMATIVE_WORDS = ["yes", "yeah", "yep", "yup", "sure", "correct", "right", "confirm", "ok", "okay", "affirmative", "alright"];
const AFFIRMATIVE_EMOJI = ["👍", "🙌", "✅", "✔️", "👌", "💯", "🤝", "😊"];
const NEGATIVE_WORDS = ["no", "nope", "nah", "incorrect", "wrong"];
const NEGATIVE_EMOJI = ["👎"];

function isAffirmative(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (AFFIRMATIVE_WORDS.some((w) => t.includes(w))) return true;
  return AFFIRMATIVE_EMOJI.some((e) => text.includes(e));
}

function isNegative(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (NEGATIVE_WORDS.some((w) => t.includes(w))) return true;
  return NEGATIVE_EMOJI.some((e) => text.includes(e));
}

// --- Recognizing a bare "hi"/"hello" with nothing else in it ---
const BARE_GREETING_RE = /^(hi+|hello+|hey+|yo+|hiya|howdy|good\s?morning|good\s?afternoon|good\s?evening|morning|evening)[\s!.,👋🙂😊]*$/i;

function isSameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
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
  let session = getSession(phone);
  const lower = text.toLowerCase();
  const now = Date.now();

  const previousLastCustomerMessageAt = session.data.lastCustomerMessageAt as number | undefined;
  const isBareGreetingMsg = BARE_GREETING_RE.test(text.trim());

  // --- Conversation boundary: is this a continuation, or a fresh start? ---
  // Coming back after 24h of silence, or opening with a bare "hi" on a new
  // calendar day, both read as the start of a new conversation — reset to
  // greeting so the customer isn't dropped back into a stale, half-done
  // booking from a day (or days) ago. Anything else — including a stray
  // "hi" said mid-booking on the SAME day — keeps the existing flow going;
  // that's handled separately below rather than treated as a reset.
  if (session.stage !== "greeting" && previousLastCustomerMessageAt) {
    const hoursSinceLast = (now - previousLastCustomerMessageAt) / 3_600_000;
    const isNewDay = !isSameCalendarDay(new Date(previousLastCustomerMessageAt), new Date(now));
    if (hoursSinceLast >= 24 || (isNewDay && isBareGreetingMsg)) {
      session = resetForNewRequest(phone);
    }
  }

  // Keep a short rolling log of the customer's own messages, and clear any
  // pending inactivity check-in flags — any reply means they're still here.
  appendMessageLog(phone, text);
  if (session.data.checkedIn || session.data.finalNudgeSent) {
    updateSession(phone, { data: { checkedIn: false, finalNudgeSent: false } });
  }
  updateSession(phone, { data: { lastCustomerMessageAt: now } });
  session = getSession(phone);

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
      const prompt = "Would you like this done on a specific date, or right away? Just reply 'schedule' or 'instant'.";
      await sendMessage(phone, `No problem, let's get you sorted. ${prompt}`);
      resetForNewRequest(phone);
      updateSession(phone, { stage: "awaiting_mode", data: { lastPrompt: prompt } });
      return;
    }
    await sendMessage(phone, "Thanks for your patience — our team's been notified and will jump in here shortly. (Say 'new request' if you'd like to start something new while you wait.)");
    return;
  }

  // Once a booking is underway, a stray "hi" or "hello" shouldn't be
  // treated as their answer to whatever we just asked, and it shouldn't
  // restart the flow either — just acknowledge it and pick up right where
  // we left off, the way a person would.
  const MID_FLOW_GUARD_STAGES: ConversationStage[] = [
    "awaiting_service_type",
    "awaiting_location",
    "awaiting_date",
    "awaiting_date_confirmation",
    "awaiting_description",
    "awaiting_special_instructions",
    "awaiting_confirmation",
  ];
  if (MID_FLOW_GUARD_STAGES.includes(session.stage) && isBareGreetingMsg) {
    const lastPrompt = (session.data.lastPrompt as string | undefined) ?? "Let's continue with your request — where were we?";
    await sendMessage(phone, `Hey! Good to hear from you — picking up right where we left off.\n\n${lastPrompt}`);
    return;
  }

  // The very first message of a conversation (or the first after a reset)
  // gets a real, contextual reply instead of an unconditional script —
  // answering a question if one was asked, acknowledging a booking intent,
  // or just welcoming them if it was a bare "hi".
  if (session.stage === "greeting") {
    const pastBookings = (session.data.pastBookings as PastBooking[] | undefined) ?? [];
    const recentMessages = (session.data.messageLog as string[] | undefined) ?? [];
    const routed = await routeIntent(text, { pastBookings, recentMessages });

    if (routed.intent === "question" && routed.reply) {
      await sendMessage(phone, routed.reply);
      return; // stay in "greeting" — they may ask more, or state what they need next
    }

    if (routed.intent === "booking_intent") {
      const ack = routed.reply ? `${routed.reply}\n\n` : "";
      const prompt = "Would you like this done on a specific date, or right away? Just reply 'schedule' or 'instant'.";
      await sendMessage(phone, `${ack}${prompt}`);
      updateSession(phone, { stage: "awaiting_mode", data: { lastPrompt: prompt } });
      return;
    }

    // "greeting" or "other" — AI already crafted a warm, open reply. Fall
    // back to a simple one if there's no key configured or it failed.
    await sendMessage(phone, routed.reply ?? "Hi there! Welcome to Hustleapp. What can I help you with today?");
    return;
  }

  if (session.stage === "awaiting_mode") {
    if (lower.includes("instant")) {
      await sendMessage(phone, "Great — what kind of service do you need? For example: plumber, electrician, hairdresser, accountant, tutor, or anything along those lines.");
      updateSession(phone, {
        stage: "awaiting_service_type",
        data: { mode: "instant" as BookingMode, lastPrompt: "What kind of service do you need?" },
      });
      return;
    }

    if (lower.includes("schedule")) {
      await sendMessage(phone, "Great — what kind of service do you need? For example: plumber, electrician, hairdresser, accountant, tutor, or anything along those lines.");
      updateSession(phone, {
        stage: "awaiting_service_type",
        data: { mode: "standard" as BookingMode, lastPrompt: "What kind of service do you need?" },
      });
      return;
    }

    // Not a direct "schedule"/"instant" — see if it's actually a question
    // first (e.g. "do you work weekends?"), answer it, then remind them
    // of the pending choice so the conversation doesn't stall.
    const pastBookings = (session.data.pastBookings as PastBooking[] | undefined) ?? [];
    const recentMessages = (session.data.messageLog as string[] | undefined) ?? [];
    const routed = await routeIntent(text, { pastBookings, recentMessages });
    const reminder = "Would you like this done on a specific date, or right away? Reply 'schedule' or 'instant'.";

    if (routed.intent === "question" && routed.reply) {
      await sendMessage(phone, `${routed.reply}\n\nAnd just to continue — ${reminder}`);
      return;
    }

    await sendMessage(phone, `Sorry, just to make sure I've got this right — ${reminder}`);
    return;
  }

  if (session.stage === "awaiting_service_type") {
    const prompt = "Which area or location is this for?";
    await sendMessage(phone, `Got it. ${prompt}`);
    updateSession(phone, { stage: "awaiting_location", data: { serviceType: text, lastPrompt: prompt } });
    return;
  }

  if (session.stage === "awaiting_location") {
    const mode = session.data.mode as BookingMode;
    if (mode === "standard") {
      const prompt = "And what date would you like this done?";
      await sendMessage(phone, prompt);
      updateSession(phone, { stage: "awaiting_date", data: { location: text, lastPrompt: prompt } });
    } else {
      const prompt = "Thanks — now tell me a bit more about what you need done. You're welcome to send a photo or video too if that helps explain it.";
      await sendMessage(phone, prompt);
      updateSession(phone, { stage: "awaiting_description", data: { location: text, lastPrompt: prompt } });
    }
    return;
  }

  if (session.stage === "awaiting_date") {
    const interpretation = await interpretDate(text, new Date());

    if (interpretation.status === "past") {
      await sendMessage(
        phone,
        `${interpretation.humanReadable ?? "That date"} has already passed — could you give me a date from today onward?`
      );
      return;
    }

    if (interpretation.status === "unclear") {
      await sendMessage(
        phone,
        "Sorry, I didn't quite catch that date — could you try again? For example: 'tomorrow', '15th August', or 'next Monday'."
      );
      return;
    }

    // We're reasonably confident, but always read it back and get an
    // explicit yes before locking it in — cheap insurance against a
    // misread date turning into a booking for the wrong day.
    const confirmPrompt = `Just to confirm — you'd like this done on ${interpretation.humanReadable}. Is that right? Reply 'yes' to confirm, or send the correct date.`;
    await sendMessage(phone, confirmPrompt);
    updateSession(phone, {
      stage: "awaiting_date_confirmation",
      data: { pendingDateHuman: interpretation.humanReadable, pendingDateIso: interpretation.isoDate, lastPrompt: confirmPrompt },
    });
    return;
  }

  if (session.stage === "awaiting_date_confirmation") {
    if (isAffirmative(text)) {
      const confirmedDate = (session.data.pendingDateHuman as string | undefined) ?? text;
      const prompt = "Thanks — now tell me a bit more about what you need done. You're welcome to send a photo or video too if that helps explain it.";
      await sendMessage(phone, prompt);
      updateSession(phone, { stage: "awaiting_description", data: { dateWanted: confirmedDate, lastPrompt: prompt } });
      return;
    }

    // Not a clear "yes" — treat their reply as a fresh date attempt rather
    // than assuming they meant "no", since they may have just retyped it.
    const interpretation = await interpretDate(text, new Date());

    if (interpretation.status === "past") {
      await sendMessage(
        phone,
        `${interpretation.humanReadable ?? "That date"} has already passed — could you give me a date from today onward?`
      );
      return;
    }

    if (interpretation.status === "unclear") {
      await sendMessage(
        phone,
        "Sorry, I still didn't catch that clearly — could you try again? For example: 'tomorrow', '15th August', or 'next Monday'."
      );
      return;
    }

    const confirmPrompt = `Got it — just to confirm, you'd like this done on ${interpretation.humanReadable}. Is that right? Reply 'yes' to confirm, or send the correct date.`;
    await sendMessage(phone, confirmPrompt);
    updateSession(phone, {
      data: { pendingDateHuman: interpretation.humanReadable, pendingDateIso: interpretation.isoDate, lastPrompt: confirmPrompt },
    });
    return;
  }

  if (session.stage === "awaiting_description") {
    const prompt =
      "Is there anything specific you'd like our artisan to pay attention to? For example preferred timing, access instructions, or anything to be careful of. Reply with details, or just say 'no' if there isn't anything.";
    await sendMessage(phone, prompt);
    updateSession(phone, { stage: "awaiting_special_instructions", data: { description: text, lastPrompt: prompt } });
    return;
  }

  if (session.stage === "awaiting_special_instructions") {
    const SKIP_WORDS = ["no", "none", "nothing", "n/a", "nope", "not really"];
    const skip = SKIP_WORDS.some((w) => lower === w || lower.startsWith(`${w} `) || lower.includes(w));
    const specialInstructions = skip ? undefined : text;

    const mode = session.data.mode as BookingMode;
    const serviceType = session.data.serviceType as string;
    const location = session.data.location as string;
    const dateWanted = session.data.dateWanted as string | undefined;
    const description = session.data.description as string;

    const summaryLines = [
      `Service: ${serviceType}`,
      `Location: ${location}`,
      ...(mode === "standard" ? [`Date: ${dateWanted}`] : []),
      `Details: ${description}`,
      ...(specialInstructions ? [`Special instructions: ${specialInstructions}`] : []),
    ];
    const confirmPrompt = `Here's what I've got:\n${summaryLines.join("\n")}\n\nDoes that look right? Reply 'yes' to send it off, or 'no' if you'd like to start over.`;
    await sendMessage(phone, confirmPrompt);
    updateSession(phone, {
      stage: "awaiting_confirmation",
      data: { specialInstructions, lastPrompt: confirmPrompt },
    });
    return;
  }

  if (session.stage === "awaiting_confirmation") {
    if (!isAffirmative(text) || isNegative(text)) {
      const prompt = "Would you like this done on a specific date, or right away? Just reply 'schedule' or 'instant'.";
      await sendMessage(phone, `No worries, let's start over. ${prompt}`);
      resetForNewRequest(phone);
      updateSession(phone, { stage: "awaiting_mode", data: { lastPrompt: prompt } });
      return;
    }

    const user = await findOrCreateUserByPhone(phone);
    const mode = session.data.mode as BookingMode;
    const attachments = (session.data.attachments as MediaAttachment[] | undefined) ?? [];
    const specialInstructions = session.data.specialInstructions as string | undefined;
    const result = await submitBookingRequest({
      userId: user.id,
      mode,
      serviceType: session.data.serviceType as string,
      location: session.data.location as string,
      dateWanted: session.data.dateWanted as string | undefined,
      description: session.data.description as string,
      specialInstructions,
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
        (specialInstructions ? `\nSpecial instructions: ${specialInstructions}` : "") +
        (attachments.length ? `\nAttachments: ${attachments.length} (forwarded below)` : "")
    );

    // Forward each attached photo/video/document straight to the agents so
    // they can see exactly what the customer sent, no separate storage needed.
    for (const attachment of attachments) {
      for (const number of AGENT_NOTIFY_NUMBERS) {
        await sendMedia(number, attachment);
      }
    }

    const booking: PastBooking = {
      requestId: result.requestId,
      mode,
      serviceType: session.data.serviceType as string,
      location: session.data.location as string,
      dateWanted: session.data.dateWanted as string | undefined,
      description: session.data.description as string,
      specialInstructions,
      submittedAt: Date.now(),
    };
    addPastBooking(phone, booking);

    // Reset the in-progress booking fields (attachments, service type,
    // etc.) so they don't leak into the next booking — but this keeps
    // booking history and recent messages, unlike a full clearSession.
    resetForNewRequest(phone);
    return;
  }

  // request_submitted or unrecognized — reset for simplicity in this skeleton
  resetForNewRequest(phone);
}

// --- 3b. Inactivity check-ins ---
// If a customer goes quiet partway through a booking, nudge them once
// after CHECK_IN_AFTER_MS of silence, then send one final "I'm here
// whenever you need me" after FINAL_NUDGE_AFTER_MS more — and then stop,
// so we're not pestering them. Any new message from them resets this
// (handled at the top of handleMessage). Adjust the timings below to
// taste — they're a starting point, not a fixed business rule.
const CHECK_IN_AFTER_MS = 10 * 60 * 1000; // 10 minutes of silence
const FINAL_NUDGE_AFTER_MS = 30 * 60 * 1000; // 30 minutes of silence total
const SWEEP_INTERVAL_MS = 60 * 1000; // check every minute

// Only nudge customers who are genuinely mid-booking and waiting on us to
// hear back from them — not on the greeting screen, not already handed to
// a human agent, and not just after finishing a booking.
const ACTIVE_STAGES: ConversationStage[] = [
  "awaiting_mode",
  "awaiting_service_type",
  "awaiting_location",
  "awaiting_date",
  "awaiting_date_confirmation",
  "awaiting_description",
  "awaiting_special_instructions",
  "awaiting_confirmation",
];

function startInactivitySweep() {
  setInterval(() => {
    const now = Date.now();
    for (const session of getAllSessions()) {
      if (!ACTIVE_STAGES.includes(session.stage)) continue;

      const lastCustomerMessageAt = session.data.lastCustomerMessageAt as number | undefined;
      if (!lastCustomerMessageAt) continue;

      const elapsed = now - lastCustomerMessageAt;
      const checkedIn = Boolean(session.data.checkedIn);
      const finalNudgeSent = Boolean(session.data.finalNudgeSent);

      if (!checkedIn && elapsed > CHECK_IN_AFTER_MS) {
        sendMessage(
          session.phone,
          "Hey, just checking in — still there? Whenever you're ready, we can carry on from where we left off."
        );
        updateSession(session.phone, { data: { checkedIn: true } });
      } else if (checkedIn && !finalNudgeSent && elapsed > FINAL_NUDGE_AFTER_MS) {
        sendMessage(
          session.phone,
          "No worries if now isn't a good time — I'm here whenever you're ready to continue, just message me anytime."
        );
        updateSession(session.phone, { data: { finalNudgeSent: true } });
      }
    }
  }, SWEEP_INTERVAL_MS);
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
  startInactivitySweep();
});
