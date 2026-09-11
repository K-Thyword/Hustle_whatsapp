import { Router, Request, Response } from "express";
import {
  getRequests,
  getAlerts,
  getConversations,
  getTranscriptForPhone,
  getTranscriptLines,
  searchTranscripts,
  getOverview,
  getAgentStats,
  sheetsConfigured,
} from "./sheetsData";
import { generateWeeklyDigest } from "./digest";
import { sendDigestToAgents, whatsappConfigured } from "./whatsapp";
import { markSeen, getAllLastSeen } from "./readState";
import { getAllContactProfiles } from "./contactDirectory";

export const api = Router();

const DAY_MS = 24 * 60 * 60 * 1000;

api.get("/status", (_req: Request, res: Response) => {
  res.json({ sheetsConfigured: sheetsConfigured() });
});

// --- Overview tab ---
api.get("/overview", async (req: Request, res: Response) => {
  const days = Number(req.query.days) || 7;
  const overview = await getOverview(days * DAY_MS, `Last ${days} day${days === 1 ? "" : "s"}`);
  res.json(overview);
});

// --- Requests tab ---
api.get("/requests", async (req: Request, res: Response) => {
  const requests = await getRequests();
  const status = req.query.status as string | undefined;
  const service = req.query.service as string | undefined;
  const filtered = requests.filter(
    (r) => (!status || (status === "open" ? r.isOpen : r.status === status)) && (!service || r.serviceType === service)
  );
  res.json(filtered);
});

// --- Alerts tab ---
api.get("/alerts", async (_req: Request, res: Response) => {
  res.json(await getAlerts());
});

// --- Chats / Transcripts tab ---

// Each conversation plus how many of the customer's messages have arrived
// since it was last opened in the dashboard (see readState.ts) — computed
// here rather than client-side so "seen" is a real, shared, persisted fact
// instead of a per-browser guess that resets whenever a browser clears its
// storage. Also enriched with a displayName when we have one on file (see
// contactDirectory.ts) — matters most for a phone/BSUID customer who's
// hidden their real number behind a WhatsApp username, since that ID alone
// gives an agent nothing to recognize them by.
api.get("/conversations", async (_req: Request, res: Response) => {
  const [convs, lines, lastSeen, contactProfiles] = await Promise.all([
    getConversations(),
    getTranscriptLines(),
    getAllLastSeen(),
    getAllContactProfiles(),
  ]);
  const enriched = convs.map((c) => {
    const seenAt = lastSeen[c.phone] || "";
    const unreadCount = lines.filter((l) => l.phone === c.phone && l.direction === "customer" && l.timestamp > seenAt).length;
    const profile = contactProfiles[c.phone];
    const displayName = profile?.name || profile?.username;
    return { ...c, unreadCount, displayName };
  });
  res.json(enriched);
});

api.get("/conversations/:phone", async (req: Request, res: Response) => {
  res.json(await getTranscriptForPhone(req.params.phone));
});

// Marks a conversation as read as of right now — called when its thread is
// opened. The only write this otherwise read-only dashboard makes, and it
// never touches the Google Sheet; it's a separate, dashboard-owned bit of
// state (see readState.ts).
api.post("/conversations/:phone/seen", async (req: Request, res: Response) => {
  await markSeen(req.params.phone);
  res.json({ ok: true });
});

// Every raw transcript line, unfiltered — used by the Chats tab's "export
// all" buttons.
api.get("/transcripts", async (_req: Request, res: Response) => {
  res.json(await getTranscriptLines());
});

api.get("/transcripts/search", async (req: Request, res: Response) => {
  const q = (req.query.q as string) ?? "";
  res.json(await searchTranscripts(q));
});

// --- Agents tab ---
api.get("/agents", async (_req: Request, res: Response) => {
  res.json(await getAgentStats());
});

// --- Reports tab ---
api.get("/digest", async (_req: Request, res: Response) => {
  res.json(await generateWeeklyDigest());
});

api.get("/digest/whatsapp-status", (_req: Request, res: Response) => {
  res.json({ configured: whatsappConfigured() });
});

// Manual trigger, mainly for verifying the WhatsApp send actually works
// without waiting for the Monday 8am scheduled run.
api.post("/digest/send-now", async (_req: Request, res: Response) => {
  const { text } = await generateWeeklyDigest();
  const result = await sendDigestToAgents(text);
  res.json(result);
});
