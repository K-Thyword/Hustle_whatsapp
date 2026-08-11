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
import { matchServiceCategory } from "./serviceCategories";
import { extractBookingDetails } from "./detailExtractor";
import { transcribeVoiceNote } from "./voiceTranscriber";
import { setMarketingOptIn, isOptedIn, getOptedInPhones } from "./marketing";
import { createReminder, getAllReminders, markReminderFired } from "./reminders";
import { extractReminderRequest } from "./reminderExtractor";
import { resolveServiceType } from "./serviceResolver";
import { logRequestEvent } from "./googleSheet";
import {
  createQuoteRequest,
  getQuoteRequest,
  updateQuoteRequest,
  getPendingCustomerAction,
  getLatestActiveRequestForPhone,
  getAllQuoteRequests,
  OPEN_STATUSES,
  QuoteRequest,
} from "./quotes";
import {
  recordAgentInbound,
  isAgentWindowOpen,
  queuePendingAgentMessage,
  queuePendingAgentMedia,
  drainPendingAgentItems,
} from "./agentMessaging";
import {
  isCustomerWindowOpen,
  queuePendingCustomerMessage,
  drainPendingCustomerItems,
} from "./customerMessaging";
import {
  startLiveChat,
  getLiveChat,
  claimLiveChat,
  unclaimLiveChat,
  endLiveChat,
  getAllLiveChats,
  markLiveChatNudgeSent,
  setActiveChatForAgent,
  getActiveChatForAgent,
  clearActiveChatForAgent,
  appendLiveChatMessage,
  LiveChat,
} from "./liveChat";

// --- Crash safety net ---
// The background sweeps below (inactivity check-ins, unclaimed-request
// nudges, unclaimed-chat nudges) fire async sends inside setInterval
// without an enclosing request/response cycle to catch failures. A
// genuine network error there (fetch() itself throwing — a DNS blip, a
// timeout — not just a non-200 response, which is already handled) would
// otherwise be an unhandled promise rejection, and Node's default
// behavior since v15 is to crash the entire process on one of those —
// taking down all webhook handling silently, with nothing in the logs to
// explain why. These two handlers are the backstop: log it and keep
// going, never let one failed background send take the whole bot offline.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (server staying up):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (server staying up):", err);
});

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
  "speak to someone",
  "speak with someone",
  "talk to someone",
  "talk with someone",
  "speak to somebody",
  "talk to somebody",
  "speak to a person",
  "talk to a person",
  "real person",
];

// Words/phrases that suggest a complaint or dispute rather than a routine
// "let me talk to someone" request — these get a distinct, higher-visibility
// notification format so they don't get buried among ordinary booking
// traffic, and they trigger escalation on their own even without the
// customer explicitly asking for an agent.
const COMPLAINT_SIGNAL_WORDS = [
  "refund",
  "complaint",
  "complain",
  "unacceptable",
  "terrible",
  "worst",
  "scam",
  "fraud",
  "rip off",
  "ripoff",
  "never showed",
  "didn't show",
  "did not show",
  "not happy",
  "unhappy",
  "disappointed",
  "ruined",
  "damaged my",
  "broke my",
  "poor service",
  "bad service",
  "not what i asked",
  "overcharged",
];

// A customer asking to cancel — either an already-submitted request, or a
// booking they're still in the middle of filling out. Handled directly by
// the bot rather than requiring them to message an agent for something
// this simple. Checked early, before escalation handling, so it works even
// if the customer is currently in "escalated" state waiting on a human.
//
// A plain \bcancel\b match (rather than a fixed list of exact phrases like
// "cancel my order") is deliberate — the old fixed-phrase list missed
// completely ordinary phrasing like "cancel the order" (no exact phrase in
// the list contained "the"), so a customer trying to cancel mid-booking
// had their message swallowed as if it were an answer to whatever question
// was being asked instead. A bare "cancel" is an unambiguous enough signal
// in a booking bot that the false-positive risk here is low.
const CANCEL_RE = /\bcancel\b/i;

// Cheap pre-filter so the reminder-extraction AI call only ever fires for
// messages that plausibly mention a reminder at all — the vast majority of
// ordinary messages never reach it.
const REMINDER_KEYWORD_RE = /\bremind(er|ers)?\b/i;

// People rarely answer "schedule"/"instant" literally — "asap", "right
// away", "urgent" all clearly mean "instant" even without saying the word.
// Checked both as a direct reply to the mode question, and against the
// customer's very first message, so urgency stated up front isn't ignored.
const INSTANT_PHRASES = ["asap", "as soon as possible", "right away", "immediately", "urgent", "urgently"];

// Lets a customer break out of "escalated" mode and start fresh — either
// while waiting for an agent to claim their conversation, or mid-way
// through an active claimed live chat (see the live-chat relay block in
// handleMessage). Module-level since both places need it.
const RESTART_TRIGGERS = ["new request", "start over", "restart", "book again", "new booking"];

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

// Optional: a backup contact who also gets pinged if a request sits
// unclaimed too long — separate from the main agent list so it can be a
// supervisor/on-call number rather than another frontline agent.
const BACKUP_AGENT_NUMBER = process.env.BACKUP_AGENT_NUMBER?.trim();

// Name of the pre-approved WhatsApp message template used to reach an
// agent outside the 24h window (see sendTemplateMessage / notifyAgentSmart
// below). Must match a template you've created and gotten approved in
// Meta Business Manager (WhatsApp Manager > Message Templates) — see the
// comment on sendTemplateMessage for the exact template to create.
const AGENT_NOTIFICATION_TEMPLATE_NAME = process.env.AGENT_NOTIFICATION_TEMPLATE_NAME || "hustle_agent_notification";

// Meta templates are versioned per language, and "English" vs "English
// (US)" are different template language codes ("en" vs "en_US") — sending
// with the wrong one fails with error 132001 ("template name does not
// exist in <language>") even though the template itself exists and is
// approved. Configurable so a mismatch can be fixed with an env var
// instead of a code change — check WhatsApp Manager > Message templates >
// hustle_agent_notification for the exact language it was created with.
const AGENT_NOTIFICATION_TEMPLATE_LANGUAGE = process.env.AGENT_NOTIFICATION_TEMPLATE_LANGUAGE || "en_US";

// Separate template for customer-facing marketing content (campaign
// broadcasts, the 30-day win-back check-in) — kept distinct from the
// agent-notification template above because WhatsApp requires marketing
// sends to use a template approved under the Marketing category
// specifically, not Utility, regardless of whether the 24h window happens
// to be open. See sendMarketingMessage below for the template to create.
const MARKETING_TEMPLATE_NAME = process.env.MARKETING_TEMPLATE_NAME || "hustle_marketing_update";
const MARKETING_TEMPLATE_LANGUAGE = process.env.MARKETING_TEMPLATE_LANGUAGE || "en_US";

// Separate again from both templates above: firing a customer's own
// reminder is a Utility send (they explicitly asked for this specific
// message), not Marketing — so it needs its own template and does NOT
// require marketing opt-in, unlike the two above.
const REMINDER_TEMPLATE_NAME = process.env.REMINDER_TEMPLATE_NAME || "hustle_reminder";
const REMINDER_TEMPLATE_LANGUAGE = process.env.REMINDER_TEMPLATE_LANGUAGE || "en_US";

// A customer-facing Utility template, used whenever an agent needs to
// reach a customer whose 24h window has closed — a live chat that went
// quiet, or a "matched"/quote/done update that lands later than expected
// (common for scheduled bookings, where the job date — and so the agent's
// follow-up — may be days after the customer last messaged the bot).
// Mirrors AGENT_NOTIFICATION_TEMPLATE_NAME, just for the other side of the
// conversation. See notifyCustomerSmart below for the template to create.
const CUSTOMER_NOTIFICATION_TEMPLATE_NAME =
  process.env.CUSTOMER_NOTIFICATION_TEMPLATE_NAME || "hustle_customer_notification";
const CUSTOMER_NOTIFICATION_TEMPLATE_LANGUAGE = process.env.CUSTOMER_NOTIFICATION_TEMPLATE_LANGUAGE || "en_US";

// Maps an agent's phone number to a display name, so a customer connected
// to a live chat sees "you're now chatting with Ama" instead of a bare
// phone number — that's what actually makes it read as a real person
// rather than another bot message. Configure in .env as
// "233556963137:Ama,233556937198:Kwame" (phone:Name pairs, comma-separated).
// An agent number with no configured name falls back to a generic label.
const AGENT_NAMES = new Map<string, string>(
  (process.env.AGENT_NAMES || "")
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [phonePart, ...nameParts] = pair.split(":");
      return [phonePart.trim(), nameParts.join(":").trim()] as [string, string];
    })
);

function getAgentName(agentPhone: string): string {
  return AGENT_NAMES.get(agentPhone) || `our agent (${agentPhone.slice(-4)})`;
}

// Sends a notification to one agent, working around WhatsApp's 24h
// window: if we've heard from them recently, send the real message
// straight away as normal; if not, queue the real content and send a
// short pre-approved template instead, so they at least get pinged that
// something's waiting. The moment they reply to that (or to anything),
// handleAgentMessage() below reopens the window and flushes the queue —
// so the full detail still reaches them, just one round-trip later
// instead of silently never arriving.
async function notifyAgentSmart(agentPhone: string, message: string, summaryLabel: string) {
  if (await isAgentWindowOpen(agentPhone)) {
    await sendMessage(agentPhone, message);
    return;
  }
  await queuePendingAgentMessage(agentPhone, message);
  await sendTemplateMessage(agentPhone, AGENT_NOTIFICATION_TEMPLATE_NAME, AGENT_NOTIFICATION_TEMPLATE_LANGUAGE, summaryLabel);
}

async function notifyAgents(message: string, summaryLabel: string = "an update") {
  for (const number of AGENT_NOTIFY_NUMBERS) {
    await notifyAgentSmart(number, message, summaryLabel);
  }
}

// Same idea as notifyAgentSmart, for the other side of the conversation:
// an agent's reply, quote, match, or completion update to a customer. If
// their window is open, it goes straight out as normal; if not, it's
// queued and a short template ping goes out instead, so the agent's
// message doesn't just silently vanish. The moment the customer replies to
// that (or sends anything else), handleMessage drains the queue and the
// full update reaches them, one round-trip later.
//
// One-time setup required in Meta Business Manager before this works:
//   Name:      hustle_customer_notification  (or set CUSTOMER_NOTIFICATION_TEMPLATE_NAME to match)
//   Category:  Utility
//   Language:  must match CUSTOMER_NOTIFICATION_TEMPLATE_LANGUAGE above (default "en_US")
//   Body:      "Hustleapp: you have {{1}} waiting. Reply to this message to see the details."
async function notifyCustomerSmart(phone: string, message: string, summaryLabel: string = "an update on your request") {
  if (await isCustomerWindowOpen(phone)) {
    await sendMessage(phone, message);
    return;
  }
  await queuePendingCustomerMessage(phone, message);
  await sendTemplateMessage(phone, CUSTOMER_NOTIFICATION_TEMPLATE_NAME, CUSTOMER_NOTIFICATION_TEMPLATE_LANGUAGE, summaryLabel);
}

// Sends one marketing message (campaign broadcast or win-back check-in) to
// an opted-in customer. Always goes via the Marketing-category template —
// unlike notifyAgentSmart's free-form-if-window-is-open shortcut, proactive
// marketing content isn't a reply to anything the customer just said, so it
// should never ride the service window; the template is the correct
// channel every time.
//
// One-time setup required in Meta Business Manager before this works:
//   Name:      hustle_marketing_update  (or set MARKETING_TEMPLATE_NAME to match)
//   Category:  Marketing
//   Language:  must match MARKETING_TEMPLATE_LANGUAGE above (default "en_US")
//   Body:      "Hustleapp: {{1}}\n\nReply STOP to opt out of these updates."
// Only ever sent to phones that have explicitly opted in (see marketing.ts)
// — never to the general customer list.
async function sendMarketingMessage(phone: string, bodyParam: string) {
  await sendTemplateMessage(phone, MARKETING_TEMPLATE_NAME, MARKETING_TEMPLATE_LANGUAGE, bodyParam);
}

// "broadcast: <message>" — any of the 3 agents can send a one-off campaign
// message to every opted-in customer. Checked as a global command (like "my
// requests"), not tied to any specific booking or live chat.
const BROADCAST_COMMAND_RE = /^broadcast:\s*([\s\S]+)$/i;

async function handleBroadcastCommand(agentPhone: string, message: string) {
  const trimmed = message.trim();
  if (!trimmed) {
    await sendMessage(agentPhone, "Usage: broadcast: <message to send opted-in customers>");
    return;
  }

  const phones = await getOptedInPhones();
  if (phones.length === 0) {
    await sendMessage(agentPhone, "No customers are opted in to marketing messages yet — nothing to send.");
    return;
  }

  let sent = 0;
  for (const phone of phones) {
    try {
      await sendMarketingMessage(phone, trimmed);
      sent++;
    } catch (err) {
      console.error(`Broadcast send failed for ${phone}:`, err);
    }
  }

  await sendMessage(agentPhone, `Broadcast sent to ${sent}/${phones.length} opted-in customer${phones.length === 1 ? "" : "s"}.`);

  // Let the other agents know a campaign went out, for visibility.
  for (const number of AGENT_NOTIFY_NUMBERS) {
    if (number === agentPhone) continue;
    await notifyAgentSmart(
      number,
      `${getAgentName(agentPhone)} sent a broadcast to ${sent} opted-in customers:\n"${trimmed}"`,
      "a broadcast that went out"
    );
  }
}

// --- Agent commands: relaying artisan questions/quotes to the customer ---
// For jobs that need a price quote rather than a fixed price, an agent
// takes the job details to the artisan, then relays whatever comes back
// through the bot using a simple format — one line, reference first:
//   req_123: quote 250 cedis
//   req_123: needs to know if it's gas or electric
//   req_123: matched Kwame the plumber
//   req_123: claim
//   req_123: done
// The bot delivers updates to the right customer, keeps a single source of
// truth for what's been said, and tracks the request's status so the
// customer's next reply gets routed back correctly.
const AGENT_COMMAND_RE =
  /^(req_\S+?)\s*:\s*(quote|needs|ask|info|matched|done|complete|completed|claim)(?:\s+([\s\S]+))?$/i;

// --- Live chat: an agent talking directly to a customer through the bot ---
// When a customer asks for a human (or a complaint is auto-detected), the
// bot notifies all agents and opens a "live chat" for that phone number.
// The first agent to claim it becomes the only one whose messages get
// relayed to the customer — same reference-first colon format as the
// req_ commands above, just keyed by the customer's phone number instead:
//   233241234567: claim                 (take the conversation)
//   233241234567: Hi, this is Ama...    (chat directly — relayed with your name)
//   233241234567: unclaim               (release it back to the team)
//   233241234567: end                   (close it out, hand back to the bot)
const LIVE_CHAT_COMMAND_RE = /^(\d{7,15})\s*:\s*([\s\S]*)$/;

const LIVE_CHAT_END_WORDS = ["end", "close", "resolved", "done"];

// Shared by both the explicit "<phone>: end" form and the bare "end" form
// (used once a conversation is an agent's active one — see
// getActiveChatForAgent). Returns false (and tells the agent why) if they
// don't have permission to end it.
async function endLiveChatAsAgent(agentPhone: string, phone: string, chat: { claimedBy?: string }): Promise<boolean> {
  if (chat.claimedBy && chat.claimedBy !== agentPhone) {
    await sendMessage(
      agentPhone,
      `This conversation is claimed by ${getAgentName(chat.claimedBy)}, not you — ask them to close it out, or "${phone}: claim" it yourself if they've stepped away.`
    );
    return false;
  }
  await endLiveChat(phone);
  await clearActiveChatForAgent(agentPhone);
  await updateSession(phone, { stage: "greeting" });
  await sendMessage(agentPhone, `Marked the conversation with ${phone} as ended.`);
  await sendMessage(
    phone,
    `Your conversation with *${getAgentName(agentPhone)}* has ended — I'm the Hustleapp assistant again if you need anything else, just let me know!`
  );
  return true;
}

// Resolves what an agent typed after "transfer" — either the target's
// phone number directly, or their configured display name (case-
// insensitive) — to an actual agent phone number. Returns undefined if it
// doesn't match a real, currently-authorised agent, so a transfer can
// never be pointed at an arbitrary number.
function resolveAgentTarget(input: string): string | undefined {
  const trimmed = input.trim();
  if (/^\d{7,15}$/.test(trimmed)) {
    return AGENT_NOTIFY_NUMBERS.includes(trimmed) ? trimmed : undefined;
  }
  const lower = trimmed.toLowerCase();
  for (const number of AGENT_NOTIFY_NUMBERS) {
    if (getAgentName(number).toLowerCase() === lower) return number;
  }
  return undefined;
}

// Hands a claimed conversation off to another agent WITH context, instead
// of the receiving agent starting cold — the recent back-and-forth (both
// sides) is summarized and sent along via notifyAgentSmart, which already
// handles the case where the target hasn't texted the bot in the last 24h.
async function transferLiveChat(agentPhone: string, phone: string, chat: LiveChat, targetInput: string): Promise<void> {
  if (chat.claimedBy !== agentPhone) {
    await sendMessage(
      agentPhone,
      chat.claimedBy
        ? `You haven't claimed the conversation with ${phone}, so there's nothing for you to transfer — ${getAgentName(chat.claimedBy)} currently has it.`
        : `You haven't claimed the conversation with ${phone} yet — claim it first with "${phone}: claim" before transferring it.`
    );
    return;
  }

  const target = resolveAgentTarget(targetInput);
  if (!target) {
    await sendMessage(
      agentPhone,
      `Couldn't find an agent matching "${targetInput}" — use their name (e.g. "transfer Julliana") or their phone number.`
    );
    return;
  }
  if (target === agentPhone) {
    await sendMessage(agentPhone, "That's already you — nothing to transfer.");
    return;
  }

  await claimLiveChat(phone, target);
  await clearActiveChatForAgent(agentPhone);
  await setActiveChatForAgent(target, phone);

  const recentLines = chat.transcript.slice(-10).map((entry) =>
    entry.from === "customer" ? `Customer: ${entry.text}` : `${getAgentName(entry.agentPhone ?? agentPhone)}: ${entry.text}`
  );
  const historyBlock = recentLines.length > 0 ? `\n\nRecent messages:\n${recentLines.join("\n")}` : "";

  await notifyAgentSmart(
    target,
    `${getAgentName(agentPhone)} transferred the conversation with ${phone} to you.${historyBlock}\n\nJust type your reply — no need to include their number. Say "end" when you're done.`,
    "a transferred conversation"
  );
  await sendMessage(agentPhone, `Transferred ${phone} to ${getAgentName(target)}.`);
  await sendMessage(phone, `You're now connected with *${getAgentName(target)}* from our team — go ahead and chat here.`);

  for (const number of AGENT_NOTIFY_NUMBERS) {
    if (number === agentPhone || number === target) continue;
    await notifyAgentSmart(
      number,
      `The conversation with ${phone} was transferred from ${getAgentName(agentPhone)} to ${getAgentName(target)} — no action needed.`,
      "a transfer update"
    );
  }
}

async function handleLiveChatCommand(agentPhone: string, phone: string, rest: string) {
  const chat = await getLiveChat(phone);
  if (!chat) {
    await sendMessage(agentPhone, `No active conversation found for ${phone} — they may not have an open escalation right now.`);
    return;
  }

  const action = rest.trim().toLowerCase();

  if (action === "claim") {
    if (chat.claimedBy && chat.claimedBy !== agentPhone) {
      await sendMessage(agentPhone, `Already claimed — the conversation with ${phone} is being handled by ${getAgentName(chat.claimedBy)}.`);
      return;
    }
    if (chat.claimedBy === agentPhone) {
      await setActiveChatForAgent(agentPhone, phone);
      await sendMessage(agentPhone, `You've already claimed the conversation with ${phone} — it's your active chat, just type your reply.`);
      return;
    }
    await claimLiveChat(phone, agentPhone);
    await setActiveChatForAgent(agentPhone, phone);
    await sendMessage(
      agentPhone,
      `You've claimed the conversation with ${phone} — it's now your active chat. Just type your reply and it'll go straight to them (no need to include their number again). Say "end" when you're done, "transfer <name>" to hand it off, or message another number to switch.`
    );
    for (const number of AGENT_NOTIFY_NUMBERS) {
      if (number === agentPhone) continue;
      await notifyAgentSmart(
        number,
        `The conversation with ${phone} has been claimed by ${getAgentName(agentPhone)} — no action needed unless they ask for help.`,
        "a claim update"
      );
    }
    await notifyCustomerSmart(
      phone,
      `You're now connected with *${getAgentName(agentPhone)}* from our team — go ahead and chat here.`,
      `a message from ${getAgentName(agentPhone)}`
    );
    return;
  }

  if (action === "unclaim" || action === "release") {
    if (chat.claimedBy !== agentPhone) {
      await sendMessage(agentPhone, `You haven't claimed the conversation with ${phone}, so there's nothing to release.`);
      return;
    }
    await unclaimLiveChat(phone);
    if (await getActiveChatForAgent(agentPhone) === phone) await clearActiveChatForAgent(agentPhone);
    await sendMessage(agentPhone, `Released the conversation with ${phone} back to the team.`);
    await notifyAgents(
      `The conversation with ${phone} is back in the pool — ${getAgentName(agentPhone)} released it. Reply "${phone}: claim" to pick it up.`,
      "an unclaimed conversation"
    );
    return;
  }

  if (LIVE_CHAT_END_WORDS.includes(action)) {
    await endLiveChatAsAgent(agentPhone, phone, chat);
    return;
  }

  const transferMatch = rest.trim().match(/^transfer\s+(.+)$/i);
  if (transferMatch) {
    await transferLiveChat(agentPhone, phone, chat, transferMatch[1].trim());
    return;
  }

  if (!rest.trim()) {
    await sendMessage(
      agentPhone,
      `Nothing to send — use "${phone}: <message>" to chat, "${phone}: claim" to claim it, "${phone}: transfer <name>" to hand it off, or "${phone}: end" to close it out.`
    );
    return;
  }

  // A plain chat message — only relay it if THIS agent is the one who
  // claimed the conversation. This is what makes "only authorised agents
  // chat with a customer" actually hold: the phone-number authorization
  // boundary (only AGENT_NOTIFY_NUMBERS are treated as agents at all) plus
  // this claim check (only the claiming agent's messages get relayed)
  // together mean a customer only ever hears from the one specific,
  // authorised person they were connected to.
  if (!chat.claimedBy) {
    await sendMessage(agentPhone, `Claim this conversation first — reply "${phone}: claim" — before chatting with ${phone}.`);
    return;
  }
  if (chat.claimedBy !== agentPhone) {
    await sendMessage(agentPhone, `This conversation is claimed by ${getAgentName(chat.claimedBy)}, not you — they're the one chatting with ${phone} right now.`);
    return;
  }

  // Explicitly naming a number also makes it the agent's active chat, so
  // an agent juggling more than one claimed conversation can switch which
  // one their plain (unprefixed) messages go to just by prefixing once.
  await setActiveChatForAgent(agentPhone, phone);
  await notifyCustomerSmart(
    phone,
    `*${getAgentName(agentPhone)}*: ${rest.trim()}`,
    `a message from ${getAgentName(agentPhone)}`
  );
  await appendLiveChatMessage(phone, "agent", rest.trim(), agentPhone);
}

// --- "my requests": an agent checking what they're currently handling ---
// No reference number needed — just a plain phrase, since it's asking
// about the agent's own claims across both booking requests and live
// chats, not acting on a specific one.
const MY_REQUESTS_TRIGGERS = ["my requests", "myrequests", "my jobs", "my claims", "my status"];

async function handleMyRequestsQuery(agentPhone: string): Promise<void> {
  const myRequests = (await getAllQuoteRequests()).filter(
    (r) => r.claimedBy === agentPhone && OPEN_STATUSES.includes(r.status)
  );
  const myChats = (await getAllLiveChats()).filter((c) => c.claimedBy === agentPhone);

  if (myRequests.length === 0 && myChats.length === 0) {
    await sendMessage(agentPhone, "You don't have any claimed requests or conversations right now.");
    return;
  }

  const lines: string[] = [];
  if (myRequests.length > 0) {
    lines.push("*Your claimed requests:*");
    for (const r of myRequests) {
      lines.push(`${r.requestId} — ${r.serviceType}, ${r.location} (${r.status})`);
    }
  }
  if (myChats.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("*Your active conversations:*");
    for (const c of myChats) {
      lines.push(c.phone);
    }
  }
  await sendMessage(agentPhone, lines.join("\n"));
}

async function notifyOtherAgentsOfClaim(requestId: string, agentPhone: string): Promise<void> {
  for (const number of AGENT_NOTIFY_NUMBERS) {
    if (number === agentPhone) continue;
    await notifyAgentSmart(
      number,
      `${requestId} has been claimed by ${getAgentName(agentPhone)} — no action needed unless they ask for help.`,
      "a claim update"
    );
  }
}

// Enforces the same "one agent at a time" exclusivity that the live-chat
// claim already has, but for booking-request actions (quote/needs/matched/
// done). Returns true if the caller may proceed — either they already own
// the request, or it was unclaimed and just got auto-claimed for them.
// Returns false (after telling the agent why) if someone else has it.
async function ensureRequestOwnership(
  agentPhone: string,
  requestId: string,
  request: QuoteRequest
): Promise<boolean> {
  if (request.claimedBy && request.claimedBy !== agentPhone) {
    await sendMessage(
      agentPhone,
      `${requestId} is claimed by ${getAgentName(request.claimedBy)} — ask them to hand it off, or "${requestId}: claim" it yourself if they've stepped away.`
    );
    return false;
  }
  if (!request.claimedBy) {
    await updateQuoteRequest(requestId, { claimedBy: agentPhone, claimedAt: Date.now() });
    await sendMessage(agentPhone, `(Auto-claimed ${requestId} for you since no one else had.)`);
    await notifyOtherAgentsOfClaim(requestId, agentPhone);
  }
  return true;
}

async function handleAgentMessage(agentPhone: string, text: string) {
  // Any inbound message from an agent reopens their 24h window — record it
  // first, then flush anything that was queued while it was closed, so the
  // full-detail notifications they missed actually arrive now.
  await recordAgentInbound(agentPhone);
  const queued = await drainPendingAgentItems(agentPhone);
  for (const item of queued) {
    if (item.type === "text") {
      await sendMessage(agentPhone, item.message);
    } else {
      await sendMedia(agentPhone, item.attachment);
    }
  }

  // A global status query, not a reference-prefixed command — checked
  // before anything else (including the active-live-chat relay below) so
  // it's never accidentally forwarded to a customer as a literal message.
  if (MY_REQUESTS_TRIGGERS.includes(text.trim().toLowerCase())) {
    await handleMyRequestsQuery(agentPhone);
    return;
  }

  const broadcastMatch = text.trim().match(BROADCAST_COMMAND_RE);
  if (broadcastMatch) {
    await handleBroadcastCommand(agentPhone, broadcastMatch[1]);
    return;
  }

  const match = text.trim().match(AGENT_COMMAND_RE);

  if (!match) {
    // Not a req_ command — try it as a live-chat command instead
    // (customer-phone-referenced: claim / a chat message / unclaim / end).
    const liveChatMatch = text.trim().match(LIVE_CHAT_COMMAND_RE);
    if (liveChatMatch) {
      const [, phone, rest] = liveChatMatch;
      await handleLiveChatCommand(agentPhone, phone, rest);
      return;
    }

    // No phone number, no reference — but if this agent already has an
    // active claimed conversation, treat the whole message as a reply to
    // that customer, so they don't have to re-type the number on every
    // single message. This is the "session" the claim opened; it stays
    // active until "end" (from either side) or a real reference switches it.
    const activeCustomer = await getActiveChatForAgent(agentPhone);
    if (activeCustomer) {
      const activeChat = await getLiveChat(activeCustomer);
      if (!activeChat || activeChat.claimedBy !== agentPhone) {
        // Stale pointer — the conversation ended some other way (customer
        // restarted, another agent took over, etc). Clear it and fall
        // through to the normal unrecognized-message handling below.
        await clearActiveChatForAgent(agentPhone);
      } else {
        const bareAction = text.trim().toLowerCase();
        if (LIVE_CHAT_END_WORDS.includes(bareAction)) {
          await endLiveChatAsAgent(agentPhone, activeCustomer, activeChat);
          return;
        }
        const bareTransferMatch = text.trim().match(/^transfer\s+(.+)$/i);
        if (bareTransferMatch) {
          await transferLiveChat(agentPhone, activeCustomer, activeChat, bareTransferMatch[1].trim());
          return;
        }
        if (text.trim()) {
          await notifyCustomerSmart(
            activeCustomer,
            `*${getAgentName(agentPhone)}*: ${text.trim()}`,
            `a message from ${getAgentName(agentPhone)}`
          );
          await appendLiveChatMessage(activeCustomer, "agent", text.trim(), agentPhone);
        }
        return;
      }
    }

    // Only nudge with the format reminder if it looks like they were
    // trying to reference something — otherwise stay quiet on casual
    // chatter like "ok" or "thanks" between agents.
    if (text.includes(":")) {
      await sendMessage(
        agentPhone,
        "Didn't catch that as a command. For a booking request:\n<reference>: quote <amount>\n<reference>: needs <question for the customer>\n<reference>: matched <provider name>\n<reference>: claim\n<reference>: done\n\nFor a live chat with a customer:\n<customer phone>: claim — then just type replies directly, no need to repeat their number\n<customer phone>: transfer <agent name> — hand it off with the recent history\n<customer phone>: end\n\nTo see what you're currently handling: my requests\n\nTo message every opted-in customer: broadcast: <message>"
      );
    }
    return;
  }

  const [, requestId, actionRaw, contentRaw] = match;
  const content = (contentRaw ?? "").trim();
  const request = await getQuoteRequest(requestId);
  if (!request) {
    await sendMessage(agentPhone, `Couldn't find a request with reference ${requestId} — double check the number.`);
    return;
  }

  const action = actionRaw.toLowerCase();

  if ((action === "quote" || action === "needs" || action === "ask" || action === "info") && !content) {
    await sendMessage(
      agentPhone,
      `Missing details — use:\n${requestId}: quote <amount>\nor\n${requestId}: needs <question for the customer>`
    );
    return;
  }

  if (action === "claim") {
    if (request.claimedBy && request.claimedBy !== agentPhone) {
      await sendMessage(agentPhone, `Already claimed — ${requestId} is being handled by ${getAgentName(request.claimedBy)}.`);
      return;
    }
    if (request.claimedBy === agentPhone) {
      await sendMessage(agentPhone, `You've already claimed ${requestId}.`);
      return;
    }
    await updateQuoteRequest(requestId, { claimedBy: agentPhone, claimedAt: Date.now() });
    await sendMessage(agentPhone, `You've claimed ${requestId} (${request.serviceType}, ${request.location}).`);
    await notifyOtherAgentsOfClaim(requestId, agentPhone);
    await logRequestEvent({
      requestId,
      event: "claimed",
      phone: request.phone,
      serviceType: request.serviceType,
      location: request.location,
      detail: agentPhone,
    });
    return;
  }

  // Every action below this point changes something about a specific job —
  // quoting it, closing it out, telling the customer who it's matched to,
  // or asking them a question. Without an ownership check here, two agents
  // working the same request at once could send the customer conflicting
  // quotes or duplicate "done" messages. If nobody's claimed it yet, taking
  // any of these actions claims it for the acting agent automatically (so
  // agents who skip typing "claim" explicitly still get the protection);
  // if someone else already has it, the action is blocked instead.
  if (!(await ensureRequestOwnership(agentPhone, requestId, request))) {
    return;
  }

  if (action === "matched") {
    await updateQuoteRequest(requestId, { matchedProvider: content || undefined });
    await notifyCustomerSmart(
      request.phone,
      `Good news — we've matched you with ${content || "a provider"} for your ${request.serviceType} request. They'll be in touch, or one of our agents will confirm details with you shortly.`,
      "a provider match for your request"
    );
    await sendMessage(agentPhone, `Match noted for ${requestId}, and the customer's been told.`);
    await logRequestEvent({
      requestId,
      event: "matched",
      phone: request.phone,
      serviceType: request.serviceType,
      location: request.location,
      detail: content,
    });
    return;
  }

  if (action === "done" || action === "complete" || action === "completed") {
    await updateQuoteRequest(requestId, { status: "completed" });
    await notifyCustomerSmart(
      request.phone,
      `Just checking in — your ${request.serviceType} job (${requestId}) has been marked as done! How did everything go? Reply with a quick rating from 1-5, or tell us how it went — it helps us keep quality high.`,
      "a follow-up on your completed job"
    );
    await sendMessage(agentPhone, `Marked ${requestId} as completed, and asked the customer for a review.`);
    await logRequestEvent({
      requestId,
      event: "completed",
      phone: request.phone,
      serviceType: request.serviceType,
      location: request.location,
    });
    return;
  }

  if (action === "quote") {
    await updateQuoteRequest(requestId, { status: "quoted", quoteAmount: content });
    await notifyCustomerSmart(
      request.phone,
      `Good news — we've got a price for your ${request.serviceType} request: ${content}.\n\nReply 'yes' to accept and we'll get your provider confirmed, or let us know if you'd like to discuss it.`,
      "a price quote for your request"
    );
    await sendMessage(agentPhone, `Quote sent to the customer for ${requestId}.`);
    await logRequestEvent({
      requestId,
      event: "quoted",
      phone: request.phone,
      serviceType: request.serviceType,
      location: request.location,
      detail: content,
    });
    return;
  }

  // "needs" / "ask" / "info" — the artisan needs more detail before pricing
  await updateQuoteRequest(requestId, { status: "awaiting_customer_info" });
  await notifyCustomerSmart(
    request.phone,
    `Quick question from our team before we can confirm a price for your ${request.serviceType} request: ${content}`,
    "a question from our team about your request"
  );
  await sendMessage(agentPhone, `Question sent to the customer for ${requestId}.`);
}

// --- Recognizing yes/no, including common emoji and a little local flavor ---
// WhatsApp conversations lean on emoji a lot for quick replies — a
// thumbs-up or high-five is exactly as much a "yes" as typing the word.
// A couple of common Twi/Ga acknowledgment words are included too.
const AFFIRMATIVE_WORDS = [
  "yes",
  "yeah",
  "yep",
  "yup",
  "sure",
  "correct",
  "right",
  "confirm",
  "ok",
  "okay",
  "affirmative",
  "alright",
  "aane", // Twi: yes
  "yoo", // common Ghanaian acknowledgment, used affirmatively
];
const AFFIRMATIVE_EMOJI = ["👍", "🙌", "✅", "✔️", "👌", "💯", "🤝", "😊"];
const NEGATIVE_WORDS = ["no", "nope", "nah", "incorrect", "wrong", "daabi"]; // "daabi" = Twi for no
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

// A reply that is ENTIRELY just a short yes/no (optionally with trailing
// punctuation) and nothing else — as opposed to a yes/no that also says
// something more ("yes, also book me a plumber"). Soft-flag handlers use
// this to tell "this reply fully answers the yes/no question, nothing left
// to process" apart from "this reply answers it AND contains a real
// message that still needs a response" — falling through to normal
// handling on a truly bare reply is what produces a spurious "how can I
// help" greeting, since it lands in the greeting stage with nothing to go
// on but the word "yes".
function isBareYesNo(text: string): boolean {
  const stripped = text
    .trim()
    .toLowerCase()
    .replace(/[!.?,\s]+$/g, "")
    .trim();
  if (AFFIRMATIVE_WORDS.includes(stripped) || NEGATIVE_WORDS.includes(stripped)) return true;
  const original = text.trim();
  return AFFIRMATIVE_EMOJI.includes(original) || NEGATIVE_EMOJI.includes(original);
}

// --- Recognizing a bare "hi"/"hello" with nothing else in it ---
// Includes a handful of common Twi/Ga greetings so customers who open in
// their own language get the same warm, natural handling as "hi"/"hello" —
// not a full bilingual bot, just recognizing the common openers.
const BARE_GREETING_RE =
  /^(hi+|hello+|hey+|yo+|hiya|howdy|good\s?morning|good\s?afternoon|good\s?evening|morning|evening|maakye|maaha|maadwo|ete\s?s[eɛ]n|wo\s?ho\s?te\s?s[eɛ]n|chale|ojekoo|agoo)[\s!.,👋🙂😊]*$/i;

// A reply like "I already mentioned that" or "as I said" is the customer
// pointing back at something they said earlier — never treat that as the
// literal answer to whatever we just asked (that's how a service type
// ends up stored as the string "i already mentioned"). If we genuinely
// can't find it in the conversation, say so honestly and ask them to
// repeat it, rather than silently accepting the deflection as data.
// The "already/earlier/before" alternative near the end also has to catch
// deflections that name a concrete thing instead of a bare pronoun — "I
// mentioned THE TIME earlier" as well as "I mentioned THAT earlier" — since
// requiring a bare pronoun right after the verb missed real-world phrasing
// like that (letting it fall through and get stored as literal answer
// text, e.g. "special instructions: i mentioned the time earlier").
const NON_ANSWER_RE =
  /\b(i\s+already\s+(mentioned|said|told|stated|gave|wrote)|already\s+(mentioned|said|told|stated)(\s+(that|this|it))?|as\s+(i\s+)?(mentioned|said|stated)|like\s+i\s+said|see\s+above|i\s+(said|told\s+you|mentioned)\s+(that|this|it)(\s+already)?|i\s+(already\s+)?(said|told\s+you|mentioned|stated)\s+\S+.{0,40}?\b(earlier|before|already|above)\b|read\s+above|scroll\s+up)\b/i;

function isNonAnswer(text: string): boolean {
  return NON_ANSWER_RE.test(text.trim());
}

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

// A photo, video, document, or voice note a customer attaches while
// describing their job — forwarded to agents as-is (by media ID) alongside
// the booking summary, so no separate file storage is needed for this
// interim setup. Voice notes additionally get transcribed (see below) so
// the bot itself can act on what was said, not just relay the file.
export interface MediaAttachment {
  id: string;
  type: "image" | "video" | "document" | "audio";
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
  } else if (message.type === "audio" && message.audio?.id) {
    // Voice note — transcribe it and treat the transcript exactly like a
    // typed message from here on (extraction, stage logic, agent commands,
    // live-chat relay all work on it unchanged). The raw audio is still
    // kept as the media attachment so it can be forwarded as-is too — e.g.
    // an agent in a claimed live chat gets both the transcript AND the
    // original file, in case they'd rather listen than read.
    const transcript = await transcribeVoiceNote(message.audio.id);
    if (!transcript) {
      await sendMessage(
        from,
        "Sorry, I couldn't quite catch that voice note — could you try sending it again, or type it out instead?"
      );
      return;
    }
    media = { id: message.audio.id, type: "audio" };
    text = transcript;
    await sendMessage(from, `🎙️ _I heard:_ "${transcript}"`);
  } else if (message.type === "location" && message.location) {
    // A dropped pin has no media ID to forward by reference the way
    // image/video/audio do (WhatsApp location messages just carry raw
    // coordinates) — so instead of adding a whole parallel attachment
    // type, this converts it into a text line with a Maps link and lets
    // it flow through every existing text path unchanged: it can be
    // picked up as a booking's location, or relayed as a normal message
    // during a live chat, in either direction (customer<->agent).
    const { latitude, longitude, name, address } = message.location;
    const mapsLink = `https://maps.google.com/?q=${latitude},${longitude}`;
    const label = [name, address].filter(Boolean).join(", ");
    text = label ? `📍 ${label} (${mapsLink})` : `📍 Location shared: ${mapsLink}`;
  }

  console.log(`Inbound from ${from}: ${text}${media ? ` [attached ${media.type}]` : ""}`);

  try {
    // Messages from an agent number are commands about a request (a
    // quote, a question for the customer), not a customer conversation.
    if (AGENT_NOTIFY_NUMBERS.includes(from)) {
      await handleAgentMessage(from, text);
    } else {
      await handleMessage(from, text, media);
    }
  } catch (err) {
    console.error("Error handling message:", err);
  }
});

// --- 3. Extra job-detail questions, tailored per service category ---
// Instead of one generic "describe the job" prompt for everything, some
// trades get a short, specific queue of questions first (headcount for
// catering, home size for cleaning, pickup/drop-off for moving...), plus a
// "one-time or regular?" question for trades where that's common, and a
// rough budget question for jobs that are normally priced with a quote.
// Unmatched service types fall straight through to the generic prompt,
// unchanged from before.
type ExtraQuestionKey = "recurring" | "followup" | "budget";
interface ExtraQuestion {
  key: ExtraQuestionKey;
  question: string;
}

async function beginJobDetails(phone: string) {
  const session = await getSession(phone);
  const serviceType = (session.data.serviceType as string) ?? "";
  const category = matchServiceCategory(serviceType);

  const queue: ExtraQuestion[] = [];
  if (category?.asksRecurring) {
    queue.push({
      key: "recurring",
      question: "Is this a one-time thing, or something you'll need regularly (like weekly or monthly)?",
    });
  }
  for (const q of category?.followUpQuestions ?? []) {
    queue.push({ key: "followup", question: q });
  }
  if (category?.likelyNeedsQuote) {
    queue.push({
      key: "budget",
      question: "Do you have a rough budget in mind for this? Reply with an amount, or say 'not sure' if you don't have one yet.",
    });
  }

  if (queue.length > 0) {
    const [first, ...rest] = queue;
    await sendMessage(phone, first.question);
    await updateSession(phone, {
      stage: "awaiting_extra_details",
      data: { extraQueue: rest, extraAnswers: [], currentExtraKey: first.key, lastPrompt: first.question },
    });
    return;
  }

  const prompt = "Thanks — now tell me a bit more about what you need done. You're welcome to send a photo or video too if that helps explain it.";
  await sendMessage(phone, prompt);
  await updateSession(phone, { stage: "awaiting_description", data: { lastPrompt: prompt } });
}

// --- 3b. Shared "what's next" routing for mode/service/location ---
// Several entry points can each independently already know the mode,
// service type, and/or location before this point in the conversation —
// a direct "schedule"/"instant" reply, a date mentioned early, or details
// already extracted and confirmed from the customer's opening message.
// These three functions form one linear chain that always asks for
// whichever of those three is still missing, and skips straight past
// anything already known — instead of every entry point independently
// (and redundantly) asking for service type, then location, from scratch.
async function askLocationQuestion(phone: string, ack: string) {
  const session = await getSession(phone);
  const pastBookings = (session.data.pastBookings as PastBooking[] | undefined) ?? [];
  const lastLocation = pastBookings.length > 0 ? pastBookings[pastBookings.length - 1].location : undefined;
  const prompt = lastLocation
    ? `${ack} Is this for ${lastLocation} again, or somewhere else? Reply 'same' to reuse it, or just tell me the new location.`
    : `${ack} Which area or location is this for?`;
  await sendMessage(phone, prompt);
  await updateSession(phone, {
    stage: "awaiting_location",
    data: { lastPrompt: prompt, suggestedLastLocation: lastLocation },
  });
}

async function proceedAfterLocation(phone: string) {
  const session = await getSession(phone);
  const mode = session.data.mode as BookingMode;

  if (mode === "standard") {
    // A date may already be locked in (confirmed as part of an earlier
    // extraction-confirmation step) — if so, there's nothing left to ask.
    const dateWanted = session.data.dateWanted as string | undefined;
    if (dateWanted) {
      await beginJobDetails(phone);
      return;
    }

    const suggestedDateHuman = session.data.suggestedDateHuman as string | undefined;
    if (suggestedDateHuman) {
      const confirmPrompt = `Just to confirm — you'd like this done on ${suggestedDateHuman}. Is that right? Reply 'yes' to confirm, or send the correct date.`;
      await sendMessage(phone, confirmPrompt);
      await updateSession(phone, {
        stage: "awaiting_date_confirmation",
        data: { pendingDateHuman: suggestedDateHuman, pendingDateIso: session.data.suggestedDateIso, lastPrompt: confirmPrompt },
      });
      return;
    }

    const prompt = "And what date would you like this done?";
    await sendMessage(phone, prompt);
    await updateSession(phone, { stage: "awaiting_date", data: { lastPrompt: prompt } });
    return;
  }

  await beginJobDetails(phone);
}

async function proceedAfterServiceType(phone: string, ack: string) {
  const session = await getSession(phone);
  if (session.data.location) {
    await proceedAfterLocation(phone);
    return;
  }
  await askLocationQuestion(phone, ack);
}

async function proceedAfterMode(
  phone: string,
  mode: BookingMode,
  suggestedDateHuman?: string,
  suggestedDateIso?: string
) {
  await updateSession(phone, { data: { mode, suggestedDateHuman, suggestedDateIso } });
  const session = await getSession(phone);

  if (session.data.serviceType) {
    await proceedAfterServiceType(phone, "Got it.");
    return;
  }

  await sendMessage(phone, "Great — what kind of service do you need? For example: plumber, electrician, hairdresser, accountant, tutor, or anything along those lines.");
  await updateSession(phone, { stage: "awaiting_service_type", data: { lastPrompt: "What kind of service do you need?" } });
}

// --- 4. Conversation logic ---
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
  let session = await getSession(phone);
  const lower = text.toLowerCase();
  const now = Date.now();

  // Flush anything an agent sent while this customer's window was closed
  // (see customerMessaging.ts / notifyCustomerSmart) — their window is
  // confirmed open the moment they message the bot at all, so any queued
  // reply, quote, match, or completion update goes out now, before
  // anything else in this message is handled.
  const queuedForCustomer = await drainPendingCustomerItems(phone);
  for (const item of queuedForCustomer) {
    if (item.type === "text") {
      await sendMessage(phone, item.message);
    } else {
      await sendMedia(phone, item.attachment);
    }
  }

  // STOP / unsubscribe — exact match, works from any stage, always takes
  // priority. This only affects marketing sends (campaigns, the win-back
  // check-in); the customer can still book normally afterward.
  const trimmedLower = text.trim().toLowerCase();
  if (trimmedLower === "stop" || trimmedLower === "unsubscribe") {
    await setMarketingOptIn(phone, false);
    await sendMessage(
      phone,
      "You're unsubscribed from Hustleapp promos and check-ins. You can still book anytime — just message us here."
    );
    return;
  }

  // Soft flag: were we waiting on a reply to the marketing opt-in ask?
  // Doesn't gate anything either way — just records a yes if there is one,
  // then falls through to normal handling so the customer's message (which
  // may be the start of a brand new request) still gets a real response.
  // Exception: a BARE "yes"/"no" with nothing else fully answers the
  // opt-in question and has nothing left to process — falling through for
  // that case lands in greeting-stage handling with only the word "yes" to
  // go on, producing a spurious "just checking — what can I help you with
  // today?" right after a customer finished an order. A reply with more
  // than just yes/no ("yes, also book me a plumber") still falls through.
  if (session.data.awaitingMarketingOptIn) {
    const bare = isBareYesNo(text);
    if (isAffirmative(text) && !isNegative(text)) {
      await setMarketingOptIn(phone, true);
      await sendMessage(
        phone,
        "Great, you're opted in — we'll send the occasional update or offer. Reply STOP anytime to opt out."
      );
    }
    await updateSession(phone, { data: { awaitingMarketingOptIn: false } });
    if (bare) return;
    session = await getSession(phone);
  }

  // Soft flag: were we waiting on a reply to the reminder-fired offer
  // ("want help booking this now?")? An affirmative reply kicks off a real
  // booking (pre-filled from the reminder text where the service is
  // recognizable) — a genuine action, so this one returns rather than
  // falling through. A bare "no" (nothing else) also returns, for the same
  // reason as the marketing flag above — it fully answers the question, so
  // falling through produces the same spurious greeting. Anything with
  // more content than a bare yes/no still falls through normally.
  if (session.data.awaitingReminderOffer) {
    const reminderText = session.data.awaitingReminderOffer as string;
    const bare = isBareYesNo(text);
    if (isAffirmative(text) && !isNegative(text)) {
      await resetForNewRequest(phone);
      const resolved = await resolveServiceType(reminderText);
      const prompt = "Would you like this done on a specific date, or right away? Just reply 'schedule' or 'instant'.";
      await sendMessage(phone, `Great — let's get that sorted. ${prompt}`);
      await updateSession(phone, {
        stage: "awaiting_mode",
        data: {
          lastPrompt: prompt,
          ...(resolved.supported ? { serviceType: resolved.serviceType ?? reminderText } : {}),
        },
      });
      return;
    }
    await updateSession(phone, { data: { awaitingReminderOffer: undefined } });
    if (bare) return;
    session = await getSession(phone);
  }

  // Continuing a reminder we don't have a usable date for yet — checked
  // early since almost anything the customer types next is meant as the
  // answer to "when should I remind you?", not a new command. "cancel" is
  // special-cased to drop the in-progress reminder rather than being
  // misread as a date.
  if (session.data.pendingReminderText) {
    const reminderText = session.data.pendingReminderText as string;

    if (CANCEL_RE.test(text)) {
      await updateSession(phone, { data: { pendingReminderText: undefined } });
      await sendMessage(phone, "No problem, I've dropped that reminder.");
      return;
    }

    const interpretation = await interpretDate(text, new Date(now));
    if (interpretation.status === "valid" && interpretation.isoDate) {
      const dueAt = Date.parse(`${interpretation.isoDate}T09:00:00Z`);
      await createReminder(phone, reminderText, dueAt);
      await updateSession(phone, { data: { pendingReminderText: undefined } });
      await sendMessage(
        phone,
        `Got it — I'll remind you to ${reminderText} on ${interpretation.humanReadable ?? interpretation.isoDate}.`
      );
      return;
    }

    if (interpretation.status === "past") {
      await sendMessage(
        phone,
        `${interpretation.humanReadable ?? "That date"} has already passed — could you give me a date from today onward?`
      );
      return;
    }

    await sendMessage(
      phone,
      `Sorry, I didn't catch a date there — when should I remind you to ${reminderText}? (e.g. "next Monday", "15 August")`
    );
    return;
  }

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
      if (session.stage === "escalated") await endLiveChat(phone);
      session = await resetForNewRequest(phone);
    }
  }

  // Keep a short rolling log of the customer's own messages — but only
  // ones actually sent to the bot, not ones sent to a live human agent
  // mid-chat. Those often address the agent by name ("thanks Tee", "ok
  // Tee"), and feeding that into the AI's "recent messages from this
  // customer" context previously caused it to mistake the agent's name
  // for the customer's own — visible as the bot greeting a customer as
  // "Tee" right after their chat with an agent named Tee had ended.
  const inClaimedLiveChat = session.stage === "escalated" && Boolean((await getLiveChat(phone))?.claimedBy);
  if (!inClaimedLiveChat) {
    await appendMessageLog(phone, text);
  }
  if (session.data.checkedIn || session.data.finalNudgeSent) {
    await updateSession(phone, { data: { checkedIn: false, finalNudgeSent: false } });
  }
  await updateSession(phone, { data: { lastCustomerMessageAt: now } });
  session = await getSession(phone);

  // If this customer is in an active, agent-claimed live chat, everything
  // they send — text and any attached media — goes straight to that agent
  // instead of through the bot's own logic. They're talking to a person
  // now, not the bot, so there's no bot-side acknowledgment for each
  // message either (a human handling it is enough). The one thing that
  // still short-circuits back to the bot is an explicit "start over" —
  // customers shouldn't be stuck in a live chat if they want to bail.
  if (session.stage === "escalated") {
    const activeChat = await getLiveChat(phone);
    if (activeChat?.claimedBy) {
      if (RESTART_TRIGGERS.some((t) => lower.includes(t))) {
        await sendMessage(activeChat.claimedBy, `Customer ${phone} started a new request — this conversation has ended.`);
        await endLiveChat(phone);
        await clearActiveChatForAgent(activeChat.claimedBy);
        const prompt = "Would you like this done on a specific date, or right away? Just reply 'schedule' or 'instant'.";
        await sendMessage(phone, `No problem, let's get you sorted. ${prompt}`);
        await resetForNewRequest(phone);
        await updateSession(phone, { stage: "awaiting_mode", data: { lastPrompt: prompt } });
        return;
      }

      if (media) {
        await sendMedia(activeChat.claimedBy, media);
      }
      if (text) {
        await sendMessage(activeChat.claimedBy, `[${phone}]: ${text}`);
        await appendLiveChatMessage(phone, "customer", text);
      }
      return;
    }
  }

  // A customer can attach a photo/video/document at any point — save it
  // against their session so it can be forwarded to agents with the rest
  // of the booking. If it arrived with no caption text, acknowledge it and
  // wait for their next message rather than advancing the flow with "".
  if (media) {
    const existing = (session.data.attachments as MediaAttachment[] | undefined) ?? [];
    await updateSession(phone, { data: { attachments: [...existing, media] } });

    if (!text) {
      await sendMessage(
        phone,
        "Got it, thanks for the photo — I've attached it to your request. Go ahead and continue whenever you're ready."
      );
      return;
    }
  }

  // A customer wanting to cancel an already-submitted request — handled
  // directly, without needing to message an agent. Checked early so it
  // works from any stage, including "escalated".
  if (CANCEL_RE.test(text)) {
    const active = await getLatestActiveRequestForPhone(phone);
    if (!active) {
      // No submitted request to cancel — but if they're still mid-way
      // through filling one out (never actually sent yet), that draft is
      // what they mean. Drop it and confirm, rather than the confusing
      // "I don't see an open request" reply, which is technically true of
      // submitted requests but not what a customer mid-booking is asking.
      if (ACTIVE_STAGES.includes(session.stage)) {
        await resetForNewRequest(phone);
        await sendMessage(
          phone,
          "No problem, I've dropped that — let me know whenever you'd like to start a new request."
        );
        return;
      }
      await sendMessage(
        phone,
        "I don't see an open request to cancel right now. If that doesn't sound right, just say 'agent' and I'll get someone to check."
      );
      return;
    }
    await updateQuoteRequest(active.requestId, { status: "cancelled" });
    await sendMessage(
      phone,
      `Done — I've cancelled request ${active.requestId} (${active.serviceType} in ${active.location}). Let me know if you'd like to book something else.`
    );
    await notifyAgents(
      `Customer ${phone} cancelled ${active.requestId} (${active.serviceType}, ${active.location}) via the bot.`,
      "a cancelled request"
    );
    await logRequestEvent({
      requestId: active.requestId,
      event: "cancelled",
      phone,
      serviceType: active.serviceType,
      location: active.location,
    });
    return;
  }

  // A customer asking to be reminded about something later. Cheap keyword
  // check first so this never costs an AI call on ordinary messages; the
  // extractor itself then confirms it's really a reminder request (and not,
  // say, "did you get my reminder") before anything is stored.
  if (REMINDER_KEYWORD_RE.test(text)) {
    const extracted = await extractReminderRequest(text);
    if (extracted.isReminderRequest && extracted.text) {
      const whenText = extracted.whenText;
      const interpretation = whenText ? await interpretDate(whenText, new Date(now)) : undefined;

      if (interpretation?.status === "valid" && interpretation.isoDate) {
        const dueAt = Date.parse(`${interpretation.isoDate}T09:00:00Z`);
        await createReminder(phone, extracted.text, dueAt);
        await sendMessage(
          phone,
          `Got it — I'll remind you to ${extracted.text} on ${interpretation.humanReadable ?? interpretation.isoDate}.`
        );
        return;
      }

      if (interpretation?.status === "past") {
        await sendMessage(
          phone,
          `${interpretation.humanReadable ?? "That date"} has already passed — could you give me a date from today onward?`
        );
        await updateSession(phone, { data: { pendingReminderText: extracted.text } });
        return;
      }

      // No usable date yet (none given, or couldn't confidently interpret
      // it) — ask for one, and remember what to remind them about so their
      // very next reply is read as the answer rather than a new message.
      await sendMessage(phone, `Sure — when should I remind you to ${extracted.text}?`);
      await updateSession(phone, { data: { pendingReminderText: extracted.text } });
      return;
    }
  }

  const isComplaintSignal = COMPLAINT_SIGNAL_WORDS.some((w) => lower.includes(w));

  if (session.stage !== "escalated" && (ESCALATION_TRIGGERS.some((t) => lower.includes(t)) || isComplaintSignal)) {
    await sendMessage(
      phone,
      "Sure thing — I'm looping in one of our team members now. Someone will be with you here shortly. (If you'd like to start a new request in the meantime, just say 'new request'.)"
    );
    await startLiveChat(phone);
    const notifyBody = isComplaintSignal
      ? `🚨 POSSIBLE COMPLAINT/DISPUTE — please prioritize 🚨\nCustomer ${phone} flagged automatically — message may indicate a complaint.\nTheir message: "${text}"\n\nReply "${phone}: claim" to pick up this conversation, then "${phone}: <message>" to chat with them directly.`
      : `Customer ${phone} asked to speak with an agent.\nTheir message: "${text}"\n\nReply "${phone}: claim" to pick up this conversation, then "${phone}: <message>" to chat with them directly.`;
    await notifyAgents(notifyBody, isComplaintSignal ? "a possible complaint" : "a customer request for an agent");
    await updateSession(phone, { stage: "escalated" });
    return;
  }

  if (session.stage === "escalated") {
    if (RESTART_TRIGGERS.some((t) => lower.includes(t))) {
      const activeChat = await getLiveChat(phone);
      if (activeChat?.claimedBy) {
        await sendMessage(activeChat.claimedBy, `Customer ${phone} started a new request — this conversation has ended.`);
        await clearActiveChatForAgent(activeChat.claimedBy);
      }
      await endLiveChat(phone);
      const prompt = "Would you like this done on a specific date, or right away? Just reply 'schedule' or 'instant'.";
      await sendMessage(phone, `No problem, let's get you sorted. ${prompt}`);
      await resetForNewRequest(phone);
      await updateSession(phone, { stage: "awaiting_mode", data: { lastPrompt: prompt } });
      return;
    }
    await sendMessage(phone, "Thanks for your patience — our team's been notified and will jump in here shortly. (Say 'new request' if you'd like to start something new while you wait.)");
    return;
  }

  // If this customer has a request sitting in "awaiting_customer_info",
  // "quoted", or "completed" (awaiting their review) — i.e. our team is
  // specifically waiting to hear back from THEM — treat their next message
  // as that reply, rather than the start of a new conversation. Only
  // applies once they're back at "greeting" (nothing else in progress), so
  // it can't hijack a brand-new booking they're partway through building.
  if (session.stage === "greeting") {
    const pending = await getPendingCustomerAction(phone);
    if (pending) {
      if (pending.status === "awaiting_customer_info") {
        await notifyAgents(`Customer's answer for ${pending.requestId}: "${text}"`, "a customer's answer");
        await updateQuoteRequest(pending.requestId, { status: "awaiting_quote" });
        await sendMessage(phone, "Thanks — I've passed that along. We'll get back to you with a price soon.");
        return;
      }

      if (pending.status === "quoted") {
        if (isAffirmative(text) && !isNegative(text)) {
          await updateQuoteRequest(pending.requestId, { status: "confirmed" });
          await sendMessage(
            phone,
            `You're confirmed! One of our agents will be in touch to arrange your provider and payment for ${pending.requestId}.`
          );
          await notifyAgents(
            `Customer accepted the quote for ${pending.requestId} (${pending.quoteAmount}). Please proceed with arranging the provider and payment.`,
            "a confirmed booking"
          );
          await logRequestEvent({
            requestId: pending.requestId,
            event: "confirmed",
            phone,
            serviceType: pending.serviceType,
            location: pending.location,
            detail: pending.quoteAmount,
          });
          return;
        }
        // Not a clear accept — forward it rather than guessing whether
        // that's a decline or just a follow-up question.
        await notifyAgents(`Customer replied about the quote for ${pending.requestId} (${pending.quoteAmount}): "${text}"`, "a customer reply");
        await sendMessage(phone, "Got it — I've passed your message along to the agent handling this.");
        return;
      }

      if (pending.status === "completed") {
        await updateQuoteRequest(pending.requestId, { status: "reviewed" });
        await sendMessage(phone, "Thank you for the feedback — really appreciate it! Let us know anytime you need something else.");
        await notifyAgents(`Customer's review for ${pending.requestId} (${pending.serviceType}): "${text}"`, "a customer review");
        await logRequestEvent({
          requestId: pending.requestId,
          event: "reviewed",
          phone,
          serviceType: pending.serviceType,
          location: pending.location,
          detail: text,
        });
        return;
      }
    }
  }

  // Once a booking is underway, a stray "hi" or "hello" shouldn't be
  // treated as their answer to whatever we just asked, and it shouldn't
  // restart the flow either — just acknowledge it and pick up right where
  // we left off, the way a person would.
  const MID_FLOW_GUARD_STAGES: ConversationStage[] = [
    "awaiting_extraction_confirmation",
    "awaiting_service_type",
    "awaiting_location",
    "awaiting_date",
    "awaiting_date_confirmation",
    "awaiting_extra_details",
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
      // Don't just acknowledge and ask everything from scratch — the
      // opening message often already states the service and/or location
      // (sometimes even a date), e.g. "I need a painter, I'm in Ho". Pull
      // those out and confirm them explicitly before moving on, so the
      // bot never re-asks for something already said, and never silently
      // assumes it understood something it didn't.
      const [extracted, dateAttempt] = await Promise.all([
        extractBookingDetails(text),
        interpretDate(text, new Date()),
      ]);
      const extractedDateHuman = dateAttempt.status === "valid" ? dateAttempt.humanReadable : undefined;
      const extractedDateIso = dateAttempt.status === "valid" ? dateAttempt.isoDate : undefined;
      const extractedMode: BookingMode | undefined = extractedDateHuman
        ? "standard"
        : INSTANT_PHRASES.some((p) => lower.includes(p))
        ? "instant"
        : undefined;

      // A service was mentioned in the opening message — check it's a real
      // request before ever building a confirmation prompt around it (and
      // normalize problem descriptions like "my AC isn't cooling" into a
      // proper service name in the process).
      if (extracted.serviceType) {
        const resolved = await resolveServiceType(extracted.serviceType);
        if (!resolved.supported) {
          const suggestionText = resolved.suggestion
            ? ` Would ${resolved.suggestion} work instead, or is there something else I can help you find?`
            : " Is there something else I can help you find?";
          await sendMessage(phone, `Sorry, that's not something we currently have providers for.${suggestionText}`);
          return; // stay at "greeting" — their next message goes through this same path again
        }
        extracted.serviceType = resolved.serviceType ?? extracted.serviceType;
      }

      if (extracted.serviceType || extracted.location) {
        let confirmPrompt: string;
        if (extracted.serviceType && extracted.location) {
          confirmPrompt = `Just to confirm — you're after a ${extracted.serviceType}, in ${extracted.location}${extractedDateHuman ? `, for ${extractedDateHuman}` : ""}. Did I get that right? Reply 'yes' to confirm, or just tell me what I got wrong.`;
        } else if (extracted.serviceType) {
          confirmPrompt = `Just to confirm — you're after a ${extracted.serviceType}${extractedDateHuman ? `, for ${extractedDateHuman}` : ""}. Did I get that right? Reply 'yes' to confirm, or just tell me what I got wrong.`;
        } else {
          confirmPrompt = `Just to confirm — this is for ${extracted.location}${extractedDateHuman ? `, for ${extractedDateHuman}` : ""}. Did I get that right? Reply 'yes' to confirm, or just tell me what I got wrong.`;
        }
        const ack = routed.reply ? `${routed.reply}\n\n` : "";
        await sendMessage(phone, `${ack}${confirmPrompt}`);
        await updateSession(phone, {
          stage: "awaiting_extraction_confirmation",
          data: {
            candidateServiceType: extracted.serviceType,
            candidateLocation: extracted.location,
            candidateDateHuman: extractedDateHuman,
            candidateDateIso: extractedDateIso,
            candidateMode: extractedMode,
            lastPrompt: confirmPrompt,
          },
        });
        return;
      }

      const ack = routed.reply ? `${routed.reply}\n\n` : "";
      const prompt = "Would you like this done on a specific date, or right away? Just reply 'schedule' or 'instant'.";
      await sendMessage(phone, `${ack}${prompt}`);
      await updateSession(phone, { stage: "awaiting_mode", data: { lastPrompt: prompt } });
      return;
    }

    // "greeting" or "other" — AI already crafted a warm, open reply. Fall
    // back to a simple one if there's no key configured or it failed.
    await sendMessage(phone, routed.reply ?? "Hi there! Welcome to Hustleapp. What can I help you with today?");
    return;
  }

  if (session.stage === "awaiting_extraction_confirmation") {
    if (isAffirmative(text) && !isNegative(text)) {
      const candidateServiceType = session.data.candidateServiceType as string | undefined;
      const candidateLocation = session.data.candidateLocation as string | undefined;
      const candidateDateHuman = session.data.candidateDateHuman as string | undefined;
      const candidateDateIso = session.data.candidateDateIso as string | undefined;
      const candidateMode = session.data.candidateMode as BookingMode | undefined;

      await updateSession(phone, {
        data: {
          serviceType: candidateServiceType,
          location: candidateLocation,
          dateWanted: candidateDateHuman,
        },
      });

      if (candidateMode) {
        await proceedAfterMode(phone, candidateMode, candidateDateHuman, candidateDateIso);
        return;
      }

      const prompt = "Would you like this done on a specific date, or right away? Just reply 'schedule' or 'instant'.";
      await sendMessage(phone, prompt);
      await updateSession(phone, { stage: "awaiting_mode", data: { lastPrompt: prompt } });
      return;
    }

    // Not a clear "yes" — but they may have jumped straight to giving a
    // date instead of confirming first (e.g. replying "friday"). Read
    // that as implicit confirmation of the service/location plus the
    // date, rather than discarding everything and starting over. The
    // date itself still goes through its own explicit confirm step below,
    // consistent with how dates are always double-checked elsewhere.
    const correctionDateAttempt = await interpretDate(text, new Date());
    if (correctionDateAttempt.status === "valid") {
      const candidateServiceType = session.data.candidateServiceType as string | undefined;
      const candidateLocation = session.data.candidateLocation as string | undefined;
      await updateSession(phone, { data: { serviceType: candidateServiceType, location: candidateLocation } });
      await proceedAfterMode(phone, "standard", correctionDateAttempt.humanReadable, correctionDateAttempt.isoDate);
      return;
    }
    if (correctionDateAttempt.status === "past") {
      await sendMessage(
        phone,
        `${correctionDateAttempt.humanReadable ?? "That date"} has already passed — could you give me a date from today onward? Or reply 'yes' if I got the service/location right and you'll give the date next.`
      );
      return;
    }

    // Genuinely not a yes and not a date — don't compound one uncertain
    // guess with another; drop back to asking the most fundamental
    // question plainly.
    const prompt = "No problem — what kind of service do you need?";
    await sendMessage(phone, prompt);
    await updateSession(phone, {
      stage: "awaiting_service_type",
      data: {
        candidateServiceType: undefined,
        candidateLocation: undefined,
        candidateDateHuman: undefined,
        candidateDateIso: undefined,
        candidateMode: undefined,
        lastPrompt: prompt,
      },
    });
    return;
  }

  if (session.stage === "awaiting_mode") {
    if (lower.includes("instant")) {
      await proceedAfterMode(phone, "instant");
      return;
    }

    if (lower.includes("schedule")) {
      await proceedAfterMode(phone, "standard");
      return;
    }

    // People rarely answer literally — "tomorrow", "asap", "next Monday",
    // "right away" all clearly mean one or the other even without saying
    // the word. Catch urgency phrasing first...
    if (INSTANT_PHRASES.some((p) => lower.includes(p))) {
      await proceedAfterMode(phone, "instant");
      return;
    }

    // ...then check whether they've actually just told us a date ("tomorrow",
    // "next Monday", "15th August") — that unambiguously means "schedule",
    // and we can remember the date now so we don't ask them to repeat it
    // later when we'd normally ask for the date.
    const dateAttempt = await interpretDate(text, new Date());
    if (dateAttempt.status === "valid") {
      await proceedAfterMode(phone, "standard", dateAttempt.humanReadable, dateAttempt.isoDate);
      return;
    }
    if (dateAttempt.status === "past") {
      await sendMessage(
        phone,
        `${dateAttempt.humanReadable ?? "That date"} has already passed — could you give me a date from today onward, or say 'instant' if you need it right away?`
      );
      return;
    }

    // Not a direct "schedule"/"instant", not urgency phrasing, not a date —
    // see if it's actually a question first (e.g. "do you work weekends?"),
    // answer it, then remind them of the pending choice so the
    // conversation doesn't stall.
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
    if (isNonAnswer(text)) {
      await sendMessage(
        phone,
        "Sorry, I don't have that noted from earlier in our chat — could you tell me again what kind of service you need?"
      );
      return;
    }

    const resolved = await resolveServiceType(text);
    if (!resolved.supported) {
      const suggestionText = resolved.suggestion ? ` Would ${resolved.suggestion} work instead, or is there something else I can help you find?` : " Is there something else I can help you find?";
      await sendMessage(phone, `Sorry, that's not something we currently have providers for.${suggestionText}`);
      return; // stay at awaiting_service_type — let them try again
    }

    await updateSession(phone, { data: { serviceType: resolved.serviceType ?? text } });
    await proceedAfterServiceType(phone, "Got it.");
    return;
  }

  if (session.stage === "awaiting_location") {
    if (isNonAnswer(text)) {
      await sendMessage(
        phone,
        "Sorry, I don't have a location noted from earlier in our chat — could you tell me again which area this is for?"
      );
      return;
    }

    // Only treat this as "reuse my last location" on a clearly closed-ended
    // reply — not on isAffirmative()'s broad substring match, since a real
    // location name could easily contain "ok"/"sure"/etc as a substring
    // (e.g. "Okaishie").
    const suggestedLastLocation = session.data.suggestedLastLocation as string | undefined;
    const trimmedLower = lower.trim();
    const wantsSameLocation =
      Boolean(suggestedLastLocation) &&
      (["same", "same place", "same location", "same as before", "same as last time"].some(
        (w) => trimmedLower === w || trimmedLower.startsWith(w)
      ) ||
        ["yes", "yeah", "yep"].includes(trimmedLower) ||
        AFFIRMATIVE_EMOJI.some((e) => text.includes(e)));
    const location = wantsSameLocation ? (suggestedLastLocation as string) : text;

    await updateSession(phone, { data: { location } });
    await proceedAfterLocation(phone);
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
    await updateSession(phone, {
      stage: "awaiting_date_confirmation",
      data: { pendingDateHuman: interpretation.humanReadable, pendingDateIso: interpretation.isoDate, lastPrompt: confirmPrompt },
    });
    return;
  }

  if (session.stage === "awaiting_date_confirmation") {
    if (isAffirmative(text)) {
      const confirmedDate = (session.data.pendingDateHuman as string | undefined) ?? text;
      await updateSession(phone, { data: { dateWanted: confirmedDate } });
      await beginJobDetails(phone);
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
    await updateSession(phone, {
      data: { pendingDateHuman: interpretation.humanReadable, pendingDateIso: interpretation.isoDate, lastPrompt: confirmPrompt },
    });
    return;
  }

  if (session.stage === "awaiting_extra_details") {
    if (isNonAnswer(text)) {
      const askedQuestion = (session.data.lastPrompt as string | undefined) ?? "that";
      await sendMessage(phone, `Sorry, I don't have an answer noted for that yet — could you tell me again: ${askedQuestion}`);
      return;
    }

    const askedQuestion = (session.data.lastPrompt as string) ?? "";
    const askedKey = (session.data.currentExtraKey as ExtraQuestionKey | undefined) ?? "followup";
    const existingAnswers =
      (session.data.extraAnswers as { key: ExtraQuestionKey; question: string; answer: string }[] | undefined) ?? [];
    const updatedAnswers = [...existingAnswers, { key: askedKey, question: askedQuestion, answer: text }];

    const queue = (session.data.extraQueue as ExtraQuestion[] | undefined) ?? [];

    if (queue.length > 0) {
      const [next, ...rest] = queue;
      await sendMessage(phone, next.question);
      await updateSession(phone, {
        data: { extraAnswers: updatedAnswers, extraQueue: rest, currentExtraKey: next.key, lastPrompt: next.question },
      });
      return;
    }

    const recurring = updatedAnswers.find((a) => a.key === "recurring")?.answer;
    const rawBudget = updatedAnswers.find((a) => a.key === "budget")?.answer;
    const BUDGET_SKIP_WORDS = ["no", "not sure", "none", "n/a", "dont know", "don't know", "idk"];
    const budget =
      rawBudget && !BUDGET_SKIP_WORDS.some((w) => rawBudget.toLowerCase().includes(w)) ? rawBudget : undefined;
    const followupPairs = updatedAnswers.filter((a) => a.key === "followup");

    if (followupPairs.length > 0) {
      // Specifics already collected via follow-up questions — skip the
      // generic "describe the job" prompt and build the description from
      // what we already have.
      const description = followupPairs.map((a) => `${a.question} ${a.answer}`).join(" | ");
      const prompt =
        "Is there anything specific you'd like our artisan to pay attention to? For example preferred timing, access instructions, or anything to be careful of. Reply with details, or just say 'no' if there isn't anything.";
      await sendMessage(phone, prompt);
      await updateSession(phone, {
        stage: "awaiting_special_instructions",
        data: { description, recurring, budget, lastPrompt: prompt },
      });
      return;
    }

    // No follow-up questions for this category (e.g. we only asked
    // recurring and/or budget) — still need the actual job description.
    const prompt = "Thanks — now tell me a bit more about what you need done. You're welcome to send a photo or video too if that helps explain it.";
    await sendMessage(phone, prompt);
    await updateSession(phone, { stage: "awaiting_description", data: { recurring, budget, lastPrompt: prompt } });
    return;
  }

  if (session.stage === "awaiting_description") {
    if (isNonAnswer(text)) {
      await sendMessage(
        phone,
        "Sorry, I don't have that noted from earlier in our chat — could you describe again what you need done?"
      );
      return;
    }
    const prompt =
      "Is there anything specific you'd like our artisan to pay attention to? For example preferred timing, access instructions, or anything to be careful of. Reply with details, or just say 'no' if there isn't anything.";
    await sendMessage(phone, prompt);
    await updateSession(phone, { stage: "awaiting_special_instructions", data: { description: text, lastPrompt: prompt } });
    return;
  }

  if (session.stage === "awaiting_special_instructions") {
    // A deflection back to something said earlier ("I mentioned the time
    // already") is neither a real answer nor a genuine "no, nothing to
    // note" — matching the awaiting_description stage's handling, ask them
    // to repeat it rather than silently storing the deflection text itself
    // as the special instructions.
    if (isNonAnswer(text)) {
      await sendMessage(
        phone,
        "Sorry, I don't have that noted from earlier in our chat — could you let me know directly what you'd like our artisan to pay attention to, or just say 'no' if there isn't anything?"
      );
      return;
    }
    const SKIP_WORDS = ["no", "none", "nothing", "n/a", "nope", "not really"];
    const skip = SKIP_WORDS.some((w) => lower === w || lower.startsWith(`${w} `) || lower.includes(w));
    const specialInstructions = skip ? undefined : text;

    const mode = session.data.mode as BookingMode;
    const serviceType = session.data.serviceType as string;
    const location = session.data.location as string;
    const dateWanted = session.data.dateWanted as string | undefined;
    const description = session.data.description as string;
    const recurring = session.data.recurring as string | undefined;
    const budget = session.data.budget as string | undefined;

    const summaryLines = [
      `Service: ${serviceType}`,
      `Location: ${location}`,
      ...(mode === "standard" ? [`Date: ${dateWanted}`] : []),
      `Details: ${description}`,
      ...(recurring ? [`Frequency: ${recurring}`] : []),
      ...(budget ? [`Budget: ${budget}`] : []),
      ...(specialInstructions ? [`Special instructions: ${specialInstructions}`] : []),
    ];
    const confirmPrompt = `Here's what I've got:\n${summaryLines.join("\n")}\n\nDoes that look right? Reply 'yes' to send it off, or 'no' if you'd like to start over.`;
    await sendMessage(phone, confirmPrompt);
    await updateSession(phone, {
      stage: "awaiting_confirmation",
      data: { specialInstructions, lastPrompt: confirmPrompt },
    });
    return;
  }

  if (session.stage === "awaiting_confirmation") {
    if (!isAffirmative(text) || isNegative(text)) {
      const prompt = "Would you like this done on a specific date, or right away? Just reply 'schedule' or 'instant'.";
      await sendMessage(phone, `No worries, let's start over. ${prompt}`);
      await resetForNewRequest(phone);
      await updateSession(phone, { stage: "awaiting_mode", data: { lastPrompt: prompt } });
      return;
    }

    const user = await findOrCreateUserByPhone(phone);
    const mode = session.data.mode as BookingMode;
    const attachments = (session.data.attachments as MediaAttachment[] | undefined) ?? [];
    const specialInstructions = session.data.specialInstructions as string | undefined;
    const recurring = session.data.recurring as string | undefined;
    const budget = session.data.budget as string | undefined;
    const result = await submitBookingRequest({
      userId: user.id,
      mode,
      serviceType: session.data.serviceType as string,
      location: session.data.location as string,
      dateWanted: session.data.dateWanted as string | undefined,
      description: session.data.description as string,
      specialInstructions,
      recurring,
      budget,
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
        (recurring ? `\nFrequency: ${recurring}` : "") +
        (budget ? `\nBudget: ${budget}` : "") +
        (specialInstructions ? `\nSpecial instructions: ${specialInstructions}` : "") +
        (attachments.length ? `\nAttachments: ${attachments.length} (forwarded below)` : "") +
        `\n\nCommands for this request:\n` +
        `${result.requestId}: claim\n` +
        `${result.requestId}: quote <amount>\n` +
        `${result.requestId}: needs <question for the customer>\n` +
        `${result.requestId}: matched <provider name>\n` +
        `${result.requestId}: done`,
      "a new booking request"
    );

    // Forward each attached photo/video/document straight to the agents so
    // they can see exactly what the customer sent, no separate storage
    // needed. Same 24h-window handling as the text notification above: if
    // an agent's window is open, send it now; if not, queue it and it'll
    // go out the moment they reply (the text notification just above
    // already prompted that reply via template if needed).
    for (const attachment of attachments) {
      for (const number of AGENT_NOTIFY_NUMBERS) {
        if (await isAgentWindowOpen(number)) {
          await sendMedia(number, attachment);
        } else {
          await queuePendingAgentMedia(number, attachment);
        }
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
      recurring,
      budget,
      submittedAt: Date.now(),
    };
    await addPastBooking(phone, booking);
    await createQuoteRequest({
      requestId: result.requestId,
      phone,
      serviceType: session.data.serviceType as string,
      location: session.data.location as string,
      mode,
    });
    await logRequestEvent({
      requestId: result.requestId,
      event: "submitted",
      phone,
      serviceType: session.data.serviceType as string,
      location: session.data.location as string,
      detail: mode,
    });

    // Reset the in-progress booking fields (attachments, service type,
    // etc.) so they don't leak into the next booking — but this keeps
    // booking history and recent messages, unlike a full clearSession.
    const shouldAskOptIn = !session.data.marketingOptInAsked && !(await isOptedIn(phone));
    await resetForNewRequest(phone);

    // Ask once, ever, per customer — right after their first successful
    // booking, since that's when they've just seen real value from the
    // service. Set the flags AFTER the reset above (not before) so they
    // survive it — resetForNewRequest only keeps data.marketingOptInAsked
    // (in PERSISTENT_DATA_KEYS) if it's actually present at the time it
    // runs, and awaitingMarketingOptIn needs to persist too, for the
    // customer's next reply to be checked against it.
    if (shouldAskOptIn) {
      await sendMessage(
        phone,
        "One more thing — want occasional updates and offers from Hustleapp? Reply YES to opt in (totally optional, and you can reply STOP anytime)."
      );
      await updateSession(phone, { data: { marketingOptInAsked: true, awaitingMarketingOptIn: true } });
    }
    return;
  }

  // request_submitted or unrecognized — reset for simplicity in this skeleton
  await resetForNewRequest(phone);
}

// --- 4b. Inactivity check-ins ---
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
  "awaiting_extraction_confirmation",
  "awaiting_mode",
  "awaiting_service_type",
  "awaiting_location",
  "awaiting_date",
  "awaiting_date_confirmation",
  "awaiting_extra_details",
  "awaiting_description",
  "awaiting_special_instructions",
  "awaiting_confirmation",
];

function startInactivitySweep() {
  setInterval(() => {
    (async () => {
      const now = Date.now();
      for (const session of await getAllSessions()) {
        if (!ACTIVE_STAGES.includes(session.stage)) continue;

        const lastCustomerMessageAt = session.data.lastCustomerMessageAt as number | undefined;
        if (!lastCustomerMessageAt) continue;

        const elapsed = now - lastCustomerMessageAt;
        const checkedIn = Boolean(session.data.checkedIn);
        const finalNudgeSent = Boolean(session.data.finalNudgeSent);

        if (!checkedIn && elapsed > CHECK_IN_AFTER_MS) {
          await sendMessage(
            session.phone,
            "Hey, just checking in — still there? Whenever you're ready, we can carry on from where we left off."
          ).catch((err) => console.error("Inactivity check-in send failed:", err));
          await updateSession(session.phone, { data: { checkedIn: true } });
        } else if (checkedIn && !finalNudgeSent && elapsed > FINAL_NUDGE_AFTER_MS) {
          await sendMessage(
            session.phone,
            "No worries if now isn't a good time — I'm here whenever you're ready to continue, just message me anytime."
          ).catch((err) => console.error("Final nudge send failed:", err));
          await updateSession(session.phone, { data: { finalNudgeSent: true } });
        }
      }
    })().catch((err) => console.error("Inactivity sweep failed:", err));
  }, SWEEP_INTERVAL_MS);
}

// --- 4c. Unclaimed-request nudge ---
// If a submitted request sits unclaimed by any agent past a threshold —
// 15 minutes for an instant request, an hour for a scheduled one — ping
// the agent group again (and a backup contact, if one's configured) so
// nothing quietly falls through the cracks. Fires once per request.
const INSTANT_UNCLAIMED_THRESHOLD_MS = 15 * 60 * 1000;
const STANDARD_UNCLAIMED_THRESHOLD_MS = 60 * 60 * 1000;

function startUnclaimedRequestSweep() {
  setInterval(() => {
    (async () => {
      const now = Date.now();
      for (const request of await getAllQuoteRequests()) {
        if (request.claimedBy) continue;
        if (!OPEN_STATUSES.includes(request.status)) continue;
        if (request.unclaimedNudgeSent) continue;

        const threshold = request.mode === "instant" ? INSTANT_UNCLAIMED_THRESHOLD_MS : STANDARD_UNCLAIMED_THRESHOLD_MS;
        if (now - request.createdAt < threshold) continue;

        const minutes = Math.round(threshold / 60000);
        const message =
          `⚠️ Unclaimed: ${request.requestId} (${request.serviceType}, ${request.location}, ${request.mode}) has been sitting for over ${minutes} minutes with no one claiming it. Please pick it up or check with the team.\n` +
          `Reply "${request.requestId}: claim" to take it.`;

        await notifyAgents(message, "an unclaimed request reminder").catch((err) =>
          console.error("Unclaimed-request nudge send failed:", err)
        );
        if (BACKUP_AGENT_NUMBER) {
          await notifyAgentSmart(BACKUP_AGENT_NUMBER, message, "an unclaimed request reminder").catch((err) =>
            console.error("Unclaimed-request backup nudge send failed:", err)
          );
        }
        await updateQuoteRequest(request.requestId, { unclaimedNudgeSent: true });
      }
    })().catch((err) => console.error("Unclaimed-request sweep failed:", err));
  }, SWEEP_INTERVAL_MS);
}

// --- 4d. Unclaimed live-chat nudge ---
// A customer asking for a human is more time-sensitive than a routine
// booking request — if nobody's claimed their conversation within 10
// minutes, ping the team again (and the backup contact, if configured) so
// it doesn't sit forgotten. Fires once per live chat.
const LIVE_CHAT_UNCLAIMED_THRESHOLD_MS = 10 * 60 * 1000;

function startUnclaimedLiveChatSweep() {
  setInterval(() => {
    (async () => {
      const now = Date.now();
      for (const chat of await getAllLiveChats()) {
        if (chat.claimedBy) continue;
        if (chat.unclaimedNudgeSent) continue;
        if (now - chat.startedAt < LIVE_CHAT_UNCLAIMED_THRESHOLD_MS) continue;

        const minutes = Math.round(LIVE_CHAT_UNCLAIMED_THRESHOLD_MS / 60000);
        const message =
          `⚠️ Unclaimed conversation: ${chat.phone} has been waiting over ${minutes} minutes with no one picking it up. Please check in.\n` +
          `Reply "${chat.phone}: claim" to take it.`;

        await notifyAgents(message, "an unclaimed conversation reminder").catch((err) =>
          console.error("Unclaimed-chat nudge send failed:", err)
        );
        if (BACKUP_AGENT_NUMBER) {
          await notifyAgentSmart(BACKUP_AGENT_NUMBER, message, "an unclaimed conversation reminder").catch((err) =>
            console.error("Unclaimed-chat backup nudge send failed:", err)
          );
        }
        await markLiveChatNudgeSent(chat.phone);
      }
    })().catch((err) => console.error("Unclaimed-chat sweep failed:", err));
  }, SWEEP_INTERVAL_MS);
}

// --- 4e. Win-back check-in ---
// A customer who's booked before but hasn't booked again in a while gets a
// simple, low-pressure check-in — not a hard sell, just "still around if
// you need anything." Only ever sent to phones that have explicitly opted
// in to marketing content (see marketing.ts); a customer who's never
// opted in can keep booking normally forever and simply never gets this.
// Re-checked every sweep tick but only actually sends once per
// WIN_BACK_AFTER_MS of continued silence, so someone who never comes back
// gets an occasional nudge rather than either nothing or a message a minute.
const WIN_BACK_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days since their last booking

function startWinBackSweep() {
  setInterval(() => {
    (async () => {
      const now = Date.now();
      for (const session of await getAllSessions()) {
        const pastBookings = (session.data.pastBookings as PastBooking[] | undefined) ?? [];
        if (pastBookings.length === 0) continue; // never booked — nothing to win back

        if (!(await isOptedIn(session.phone))) continue;

        const lastBooking = pastBookings.reduce((latest, b) => (b.submittedAt > latest.submittedAt ? b : latest));
        const lastWinBackSentAt = session.data.lastWinBackSentAt as number | undefined;
        const sinceLastBooking = now - lastBooking.submittedAt;
        const sinceLastWinBack = lastWinBackSentAt ? now - lastWinBackSentAt : Infinity;

        if (sinceLastBooking < WIN_BACK_AFTER_MS) continue; // booked recently enough, nothing to do
        if (sinceLastWinBack < WIN_BACK_AFTER_MS) continue; // already checked in recently, don't repeat

        await sendMarketingMessage(
          session.phone,
          `it's been a while! Last time we helped you find a ${lastBooking.serviceType}. Need a hand with anything today?`
        ).catch((err) => console.error("Win-back send failed:", err));

        await updateSession(session.phone, { data: { lastWinBackSentAt: now } });
      }
    })().catch((err) => console.error("Win-back sweep failed:", err));
  }, SWEEP_INTERVAL_MS);
}

// --- 4f. Reminder firing ---
// Fires any reminder whose due time has passed, via the Utility-category
// reminder template — no marketing opt-in needed, since the customer
// explicitly asked for this exact message. The template itself both
// delivers the reminder and offers to help book it; a customer who replies
// affirmatively is caught by the awaitingReminderOffer soft flag in
// handleMessage above, which kicks off a real booking pre-filled from the
// reminder's text.
function startReminderSweep() {
  setInterval(() => {
    (async () => {
      const now = Date.now();
      for (const reminder of await getAllReminders()) {
        if (reminder.fired) continue;
        if (reminder.dueAt > now) continue;

        await sendTemplateMessage(reminder.phone, REMINDER_TEMPLATE_NAME, REMINDER_TEMPLATE_LANGUAGE, reminder.text).catch(
          (err) => console.error("Reminder send failed:", err)
        );
        await markReminderFired(reminder.id);
        await updateSession(reminder.phone, { data: { awaitingReminderOffer: reminder.text } });
      }
    })().catch((err) => console.error("Reminder sweep failed:", err));
  }, SWEEP_INTERVAL_MS);
}

// --- 5. Outbound sender ---
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

// Sends a pre-approved WhatsApp message template — the only kind of
// business-initiated message WhatsApp allows outside a recipient's 24h
// window. Used by notifyAgentSmart() to reach an agent who hasn't texted
// the bot recently; the actual detailed content is queued and delivered
// as a normal free-form message once they reply (see agentMessaging.ts).
//
// One-time setup required in Meta Business Manager before this works
// (WhatsApp Manager > Account tools > Message Templates > Create Template):
//   Name:      hustle_agent_notification  (or set AGENT_NOTIFICATION_TEMPLATE_NAME to match whatever you name it)
//   Category:  Utility
//   Language:  must match AGENT_NOTIFICATION_TEMPLATE_LANGUAGE above (default "en_US" — pick
//              "English (US)" specifically in the template creator, not just "English", which
//              is a different language code ("en") and will fail with error 132001 otherwise)
//   Body:      "Hustleapp: you have {{1}} waiting for you. Reply to this message to see the full details."
// Submit for review — Meta typically approves utility templates within
// minutes to a few hours. Until it's approved (or if the language code
// doesn't match), calls to this function will fail and log an error (same
// graceful-failure pattern as sendMessage) — nothing else in the app
// depends on it succeeding, though the queued notification behind it won't
// reach the agent until they message the bot some other way.
async function sendTemplateMessage(to: string, templateName: string, languageCode: string, bodyParam: string) {
  const hasRealCredentials =
    process.env.WHATSAPP_ACCESS_TOKEN &&
    process.env.WHATSAPP_ACCESS_TOKEN !== "from-meta-business-manager";

  if (!hasRealCredentials) {
    console.log(`[DRY RUN — would send template "${templateName}" (${languageCode}) to ${to} with param "${bodyParam}"]`);
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
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components: [{ type: "body", parameters: [{ type: "text", text: bodyParam }] }],
      },
    }),
  });

  if (!res.ok) {
    console.error("Failed to send template message:", await res.text());
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
  startUnclaimedRequestSweep();
  startUnclaimedLiveChatSweep();
  startWinBackSweep();
  startReminderSweep();
});
