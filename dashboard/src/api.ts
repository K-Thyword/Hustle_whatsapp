import { Router, Request, Response } from "express";
import {
  getRequests,
  getAlerts,
  getConversations,
  getTranscriptForPhone,
  searchTranscripts,
  getOverview,
  getAgentStats,
  sheetsConfigured,
} from "./sheetsData";
import { generateWeeklyDigest } from "./digest";
import { sendDigestToAgents, whatsappConfigured } from "./whatsapp";

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
api.get("/conversations", async (_req: Request, res: Response) => {
  res.json(await getConversations());
});

api.get("/conversations/:phone", async (req: Request, res: Response) => {
  res.json(await getTranscriptForPhone(req.params.phone));
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
