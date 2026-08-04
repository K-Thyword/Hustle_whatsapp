import "dotenv/config";
import express, { Request, Response } from "express";
import { getSession, updateSession } from "./session";
import { getAvailableProviders, findOrCreateUserByPhone, createOrder } from "./appApi";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

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

// --- 3. Minimal conversation logic ---
// This is intentionally simple — a real intent layer (LLM or button-driven
// WhatsApp Flow) replaces the string matching below. The point of this
// skeleton is the session + backend-call wiring, not the NLU.
async function handleMessage(phone: string, text: string) {
  const session = getSession(phone);
  const lower = text.toLowerCase();

  if (session.stage === "greeting") {
    await sendMessage(phone, "Hi! What do you need — a delivery, a ride, or something else?");
    updateSession(phone, { stage: "awaiting_service_type" });
    return;
  }

  if (session.stage === "awaiting_service_type") {
    const serviceType = lower.includes("ride") ? "ride" : "delivery";
    const user = await findOrCreateUserByPhone(phone);
    const providers = await getAvailableProviders(serviceType);

    if (providers.length === 0) {
      await sendMessage(phone, "No providers available right now — try again shortly.");
      return;
    }

    const list = providers
      .map((p, i) => `${i + 1}. ${p.name} — ~${p.etaMinutes} min`)
      .join("\n");
    await sendMessage(phone, `Available now:\n${list}\n\nReply with a number to confirm.`);
    updateSession(phone, {
      stage: "awaiting_confirmation",
      data: { serviceType, providers, userId: user.id },
    });
    return;
  }

  if (session.stage === "awaiting_confirmation") {
    const providers = session.data.providers as { id: string; name: string }[];
    const choice = parseInt(text, 10) - 1;
    const picked = providers?.[choice];

    if (!picked) {
      await sendMessage(phone, "Please reply with a valid number from the list.");
      return;
    }

    const order = await createOrder({
      userId: session.data.userId as string,
      providerId: picked.id,
      serviceType: session.data.serviceType as string,
      channel: "whatsapp",
    });

    await sendMessage(phone, `Order confirmed with ${picked.name}. Order ID: ${order.orderId}`);
    updateSession(phone, { stage: "order_placed" });
    return;
  }

  // order_placed or unrecognized — reset for simplicity in this skeleton
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
