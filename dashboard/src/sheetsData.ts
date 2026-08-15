// Read-only access to the same Google Sheet the WhatsApp bot writes to
// (see ../../src/googleSheet.ts for the write side and the sheet's exact
// layout). This module never writes — only ever reads Sheet1 (the event
// log + ALERT rows) and Transcripts (every message), and reshapes both
// into the views the dashboard's tabs actually need: Sheet1 is an
// append-only event stream, not a live "current state" table, so
// "Requests" in particular has to be built by grouping rows by reference
// and taking each one's latest event.

import { google } from "googleapis";

const SHEET_ID = process.env.GOOGLE_SHEETS_ID;
const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SERVICE_ACCOUNT_PRIVATE_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

const isConfigured = Boolean(SHEET_ID && SERVICE_ACCOUNT_EMAIL && SERVICE_ACCOUNT_PRIVATE_KEY);

// Same defensive normalization as the bot's googleSheet.ts — protects
// against the single most common copy-paste mistake with a service
// account's private key (pasting it WITH the surrounding JSON quotes).
function normalizePrivateKey(raw: string): string {
  let key = raw.trim();
  if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1);
  return key.replace(/\\n/g, "\n");
}

let sheetsClient: ReturnType<typeof google.sheets> | null = null;
function getClient() {
  if (!isConfigured) return null;
  if (sheetsClient) return sheetsClient;
  const auth = new google.auth.JWT({
    email: SERVICE_ACCOUNT_EMAIL,
    key: normalizePrivateKey(SERVICE_ACCOUNT_PRIVATE_KEY as string),
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

export function sheetsConfigured(): boolean {
  return isConfigured;
}

// Short in-memory cache so switching tabs or refreshing doesn't hit the
// Sheets API on every click — a live dashboard doesn't need sub-second
// freshness for an ops log like this.
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; rows: string[][] }>();

async function fetchRange(range: string): Promise<string[][]> {
  const cached = cache.get(range);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.rows;

  const client = getClient();
  if (!client) return [];

  try {
    const res = await client.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range });
    const rows = (res.data.values as string[][] | undefined) ?? [];
    cache.set(range, { at: Date.now(), rows });
    return rows;
  } catch (err) {
    console.error(`Failed to read range ${range} from Google Sheet:`, err);
    // Serve stale data rather than an empty dashboard if a transient read fails.
    return cached?.rows ?? [];
  }
}

export async function fetchSheet1Rows(): Promise<string[][]> {
  const rows = await fetchRange("Sheet1!A:G");
  return rows.slice(1); // drop header row
}

export async function fetchTranscriptRows(): Promise<string[][]> {
  const rows = await fetchRange("Transcripts!A:D");
  return rows.slice(1);
}

// --- Agent display names — same "phone:Name,phone:Name" format as the
// bot service's AGENT_NAMES env var, so both services can read the exact
// same value without translation. ---
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

export function agentName(phone: string): string {
  return AGENT_NAMES.get(phone) || `Agent (${phone.slice(-4)})`;
}

// --- Requests: group Sheet1's append-only event rows by reference ---

export type RequestStatus =
  | "submitted"
  | "claimed"
  | "quoted"
  | "matched"
  | "confirmed"
  | "completed"
  | "reviewed"
  | "cancelled";

const OPEN_STATUSES: RequestStatus[] = ["submitted", "claimed", "quoted", "matched", "confirmed"];

export interface RequestEvent {
  event: RequestStatus;
  timestamp: string;
  detail: string;
}

export interface RequestSummary {
  requestId: string;
  customer: string;
  serviceType: string;
  location: string;
  mode?: string; // "standard" | "instant" — from the "submitted" event's detail
  status: RequestStatus;
  isOpen: boolean;
  claimedByPhone?: string;
  claimedByName?: string;
  submittedAt: string;
  lastUpdated: string;
  timeline: RequestEvent[];
}

export async function getRequests(): Promise<RequestSummary[]> {
  const rows = await fetchSheet1Rows();
  const byRequest = new Map<string, RequestSummary>();

  for (const row of rows) {
    const [timestamp, requestId, event, phone, serviceType, location, detail] = row;
    if (!requestId || requestId === "ALERT") continue; // ALERT rows aren't requests — see getAlerts()

    let summary = byRequest.get(requestId);
    if (!summary) {
      summary = {
        requestId,
        customer: phone ?? "",
        serviceType: serviceType ?? "",
        location: location ?? "",
        status: (event as RequestStatus) ?? "submitted",
        isOpen: true,
        submittedAt: timestamp,
        lastUpdated: timestamp,
        timeline: [],
      };
      byRequest.set(requestId, summary);
    }

    summary.timeline.push({ event: event as RequestStatus, timestamp, detail: detail ?? "" });
    summary.status = event as RequestStatus; // rows are appended in order, so the latest wins
    summary.isOpen = OPEN_STATUSES.includes(summary.status);
    summary.lastUpdated = timestamp;
    if (serviceType) summary.serviceType = serviceType;
    if (location) summary.location = location;

    if (event === "submitted" && detail) summary.mode = detail;
    if (event === "claimed" && detail) {
      summary.claimedByPhone = detail;
      summary.claimedByName = agentName(detail);
    }
  }

  return Array.from(byRequest.values()).sort((a, b) => (a.lastUpdated < b.lastUpdated ? 1 : -1));
}

// --- Alerts: delivery-failure rows logged by googleSheet.ts's logAlert() ---

export interface AlertEntry {
  timestamp: string;
  message: string;
}

export async function getAlerts(): Promise<AlertEntry[]> {
  const rows = await fetchSheet1Rows();
  return rows
    .filter((row) => row[1] === "ALERT")
    .map((row) => ({ timestamp: row[0], message: row[6] ?? "" }))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

// --- Transcripts / Chats: every message, grouped or filtered by phone ---

export interface TranscriptLine {
  timestamp: string;
  phone: string;
  direction: "customer" | "bot";
  text: string;
}

export interface ConversationSummary {
  phone: string;
  lastMessage: string;
  lastTimestamp: string;
  messageCount: number;
}

async function getTranscriptLines(): Promise<TranscriptLine[]> {
  const rows = await fetchTranscriptRows();
  return rows
    .filter((row) => row.length >= 4)
    .map((row) => ({
      timestamp: row[0],
      phone: row[1],
      direction: row[2] as "customer" | "bot",
      text: row[3],
    }));
}

export async function getConversations(): Promise<ConversationSummary[]> {
  const lines = await getTranscriptLines();
  const byPhone = new Map<string, ConversationSummary>();

  for (const line of lines) {
    const existing = byPhone.get(line.phone);
    if (!existing || line.timestamp >= existing.lastTimestamp) {
      byPhone.set(line.phone, {
        phone: line.phone,
        lastMessage: line.text,
        lastTimestamp: line.timestamp,
        messageCount: (existing?.messageCount ?? 0) + 1,
      });
    } else {
      existing.messageCount += 1;
    }
  }

  return Array.from(byPhone.values()).sort((a, b) => (a.lastTimestamp < b.lastTimestamp ? 1 : -1));
}

export async function getTranscriptForPhone(phone: string): Promise<TranscriptLine[]> {
  const lines = await getTranscriptLines();
  return lines.filter((l) => l.phone === phone).sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
}

export async function searchTranscripts(query: string): Promise<TranscriptLine[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const lines = await getTranscriptLines();
  return lines
    .filter((l) => l.text.toLowerCase().includes(q) || l.phone.includes(q))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
    .slice(0, 200);
}

// --- Overview: KPI roll-up for a given lookback window ---

export interface OverviewStats {
  windowLabel: string;
  submitted: number;
  completed: number;
  cancelled: number;
  open: number;
  alerts: number;
  strugglingConversations: number;
  byService: Record<string, number>;
}

export async function getOverview(sinceMs: number, windowLabel: string): Promise<OverviewStats> {
  const [requests, alerts] = await Promise.all([getRequests(), getAlerts()]);
  const since = new Date(Date.now() - sinceMs).toISOString();

  const inWindow = requests.filter((r) => r.submittedAt >= since);
  const byService: Record<string, number> = {};
  for (const r of inWindow) {
    byService[r.serviceType] = (byService[r.serviceType] ?? 0) + 1;
  }

  return {
    windowLabel,
    submitted: inWindow.length,
    completed: inWindow.filter((r) => r.status === "completed" || r.status === "reviewed").length,
    cancelled: inWindow.filter((r) => r.status === "cancelled").length,
    open: requests.filter((r) => r.isOpen).length, // all-time open, not just this window
    alerts: alerts.filter((a) => a.timestamp >= since).length,
    strugglingConversations: 0, // struggle alerts flow through notifyAgents (WhatsApp), not the Sheet — see README
    byService,
  };
}

// --- Agents: workload derived from "claimed" event rows ---

export interface AgentStat {
  phone: string;
  name: string;
  claimed: number;
  open: number;
  completed: number;
}

export async function getAgentStats(): Promise<AgentStat[]> {
  const requests = await getRequests();
  const byAgent = new Map<string, AgentStat>();

  for (const r of requests) {
    if (!r.claimedByPhone) continue;
    let stat = byAgent.get(r.claimedByPhone);
    if (!stat) {
      stat = { phone: r.claimedByPhone, name: r.claimedByName ?? agentName(r.claimedByPhone), claimed: 0, open: 0, completed: 0 };
      byAgent.set(r.claimedByPhone, stat);
    }
    stat.claimed += 1;
    if (r.isOpen) stat.open += 1;
    if (r.status === "completed" || r.status === "reviewed") stat.completed += 1;
  }

  return Array.from(byAgent.values()).sort((a, b) => b.claimed - a.claimed);
}
