// Optional shared activity log: every meaningful event on a request
// (submitted, claimed, quoted, matched, confirmed, completed, cancelled,
// reviewed) gets appended as a row to a Google Sheet, so any agent (or you)
// can see what's open, claimed, or done without scrolling through
// individual WhatsApp threads — without needing a real dashboard/DB yet.
//
// This is an event log, not a live-updating one-row-per-request table:
// each row is a timestamped event, and a request's current state is
// whatever its most recent row says. That avoids needing to look up and
// edit a specific row in place (a real dashboard/DB is the right place for
// a mutable view later — this just gets something useful today).
//
// Fully optional — if the env vars below aren't set, this quietly no-ops
// (logs to console instead) so nothing else in the app depends on it.
//
// Setup (when you're ready to turn this on):
//   1. Create a Google Cloud project (or reuse one) and enable the Google
//      Sheets API.
//   2. Create a Service Account, and create a JSON key for it.
//   3. Create a Google Sheet, and share it (Editor access) with the
//      service account's email address (looks like
//      something@project-id.iam.gserviceaccount.com).
//   4. Add to .env / Railway variables:
//        GOOGLE_SHEETS_ID=<the long ID in the sheet's URL>
//        GOOGLE_SERVICE_ACCOUNT_EMAIL=<from the JSON key>
//        GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=<the "private_key" field from
//          the JSON key, kept as one line with \n for line breaks>
//   5. First row of the sheet (headers), optional but recommended:
//        Timestamp | Reference | Event | Customer | Service | Location | Detail
//   6. For full conversation transcripts (see logTranscriptLine below), add
//      a SECOND tab to the same spreadsheet named exactly "Transcripts",
//      with header row: Timestamp | Phone | Direction | Message
//      (kept on its own tab, not mixed into Sheet1's event log, since it's
//      a much higher-volume, different-shaped stream — every message, not
//      just lifecycle events)
//   7. For ad/post click attribution (see logReferral below), add a THIRD
//      tab named exactly "Referrals", header row:
//        Timestamp | Phone | SourceType | Headline | Body | SourceURL | CTWA_CLID
//   8. For the bot to answer "is your post about X still on?" type
//      questions (see getRecentPosts below), add a FOURTH tab named
//      exactly "Posts", header row: Date | Platform | Summary | Link
//      — kept updated either by hand, or automatically for Instagram if
//      INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_BUSINESS_ACCOUNT_ID are set (see
//      instagramSync.ts) — both ways write to the same tab, so a manual
//      row and an auto-synced row look identical to getRecentPosts().

import { google } from "googleapis";

const SHEET_ID = process.env.GOOGLE_SHEETS_ID;
const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SERVICE_ACCOUNT_PRIVATE_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

const isConfigured = Boolean(SHEET_ID && SERVICE_ACCOUNT_EMAIL && SERVICE_ACCOUNT_PRIVATE_KEY);

let sheetsClient: ReturnType<typeof google.sheets> | null = null;

// The single most common way this env var arrives broken: someone copies
// the private_key field straight out of the downloaded JSON key file
// INCLUDING the surrounding double quotes (those are JSON string
// delimiters, not part of the actual key) — OpenSSL then fails with an
// opaque "DECODER routines::unsupported" error that gives no hint what's
// actually wrong. Stripped defensively here so that one common mistake
// doesn't need a round trip to notice.
function normalizePrivateKey(raw: string): string {
  let key = raw.trim();
  if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1);
  return key.replace(/\\n/g, "\n");
}

function getClient() {
  if (!isConfigured) return null;
  if (sheetsClient) return sheetsClient;

  const auth = new google.auth.JWT({
    email: SERVICE_ACCOUNT_EMAIL,
    key: normalizePrivateKey(SERVICE_ACCOUNT_PRIVATE_KEY as string),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

export interface RequestLogEvent {
  requestId: string;
  event:
    | "submitted"
    | "claimed"
    | "quoted"
    | "matched"
    | "confirmed"
    | "completed"
    | "reviewed"
    | "cancelled";
  phone: string;
  serviceType: string;
  location: string;
  detail?: string;
}

export async function logRequestEvent(row: RequestLogEvent): Promise<void> {
  const client = getClient();

  if (!client) {
    // Not configured yet — this is expected until the setup steps above
    // are done, so keep this quiet (just a log line, not a warning).
    console.log("[Sheet log DRY RUN]", row);
    return;
  }

  try {
    await client.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A:G",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            new Date().toISOString(),
            row.requestId,
            row.event,
            row.phone,
            row.serviceType,
            row.location,
            row.detail ?? "",
          ],
        ],
      },
    });
  } catch (err) {
    // Never let a logging failure break the actual customer/agent flow.
    console.error("Failed to append to Google Sheet log:", err);
  }
}

// A visible, checkable record of a notification that never actually
// reached anyone — e.g. an agent's (or customer's) WhatsApp window was
// closed AND the fallback template ping also failed to send, usually
// because the template isn't approved yet in Meta or its language code
// doesn't match. Before this, that failure only ever showed up as a
// console.error line on the server — invisible to anyone without log
// access, including whoever's actually waiting to hear about a booking.
// Appended to the same sheet bookings already get logged to, so it's
// somewhere a human will actually see it, plus always printed to the
// console either way for anyone watching server logs.
export async function logAlert(message: string): Promise<void> {
  console.error("🚨 ALERT:", message);

  const client = getClient();
  if (!client) return; // sheet not configured — the console line above is all we get for now

  try {
    await client.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A:G",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[new Date().toISOString(), "ALERT", "delivery_failed", "", "", "", message]],
      },
    });
  } catch (err) {
    console.error("Failed to append alert to Google Sheet log:", err);
  }
}

// The actual back-and-forth of a conversation — not just the discrete
// lifecycle events logRequestEvent captures. Without this, nobody but the
// customer (and a live-chat agent, once one's claimed) ever sees what was
// actually said; every bug found so far this project came from someone
// manually screenshotting a test conversation, not from the system
// surfacing anything on its own. "bot" direction covers everything the
// customer receives — scripted bot replies AND an agent's relayed live-chat
// messages alike, since from the customer's side of the phone it's all
// just "Hustleapp" either way.
export type TranscriptDirection = "customer" | "bot";

export async function logTranscriptLine(phone: string, direction: TranscriptDirection, text: string): Promise<void> {
  if (!text) return;
  const client = getClient();
  const row = [new Date().toISOString(), phone, direction, text];

  if (!client) {
    console.log("[Transcript log DRY RUN]", row);
    return;
  }

  try {
    await client.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Transcripts!A:D",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });
  } catch (err) {
    // Never let a logging failure break the actual customer/agent flow.
    console.error("Failed to append to Transcripts sheet log:", err);
  }
}

// When a customer taps "Send Message" on a Facebook/Instagram ad or a
// boosted post, WhatsApp attaches a "referral" object to that first
// inbound message — which ad/post it was, its headline/body, and (for
// paid ads) a click ID Meta uses for attribution. Logged here purely for
// visibility (which posts are actually driving conversations) — the
// SAME data is also passed live into intentRouter's context so the bot's
// opening reply can acknowledge it, see server.ts's webhook handler.
// Add a THIRD tab to the sheet named exactly "Referrals", header row:
//   Timestamp | Phone | SourceType | Headline | Body | SourceURL | CTWA_CLID
export interface MessageReferral {
  sourceType?: string; // "ad" | "post"
  sourceUrl?: string;
  sourceId?: string;
  headline?: string;
  body?: string;
  mediaType?: string;
  ctwaClid?: string;
}

export async function logReferral(phone: string, referral: MessageReferral): Promise<void> {
  const row = [
    new Date().toISOString(),
    phone,
    referral.sourceType ?? "",
    referral.headline ?? "",
    referral.body ?? "",
    referral.sourceUrl ?? "",
    referral.ctwaClid ?? "",
  ];

  const client = getClient();
  if (!client) {
    console.log("[Referral log DRY RUN]", row);
    return;
  }

  try {
    await client.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Referrals!A:G",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });
  } catch (err) {
    console.error("Failed to append to Referrals sheet log:", err);
  }
}

// A short, manually-maintained list of recent posts/promotions — so a
// customer asking "is the offer from your post still on?" with no ad
// click involved (nothing for WhatsApp to attach automatically, unlike
// logReferral above) still gets a real answer instead of "I'm not sure."
// Add a FOURTH tab to the sheet named exactly "Posts", header row:
//   Date | Platform | Summary | Link
// Update it yourself whenever you post something worth the bot knowing
// about — no code change or redeploy needed, it's read fresh (with a
// short cache) on the next customer message.
export interface PostEntry {
  date: string;
  platform: string;
  summary: string;
  link?: string;
}

let postsCache: { at: number; posts: PostEntry[] } | null = null;
const POSTS_CACHE_TTL_MS = 5 * 60 * 1000;

// Used by instagramSync.ts to auto-append newly detected Instagram posts on
// each polling run without creating duplicate rows every time — dedupes by
// link (the permalink), since that's the one field guaranteed both stable
// and unique per post, unlike a Summary a human might later edit by hand.
// Returns whether a row was actually added (false = already present, or
// sheet not configured).
export async function appendPostIfNew(entry: PostEntry): Promise<boolean> {
  const client = getClient();
  if (!client) {
    console.log("[Posts sync DRY RUN]", entry);
    return false;
  }

  try {
    const existing = await client.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Posts!D2:D",
    });
    const existingLinks = new Set(
      ((existing.data.values as string[][] | undefined) ?? []).map((r) => r[0]).filter(Boolean)
    );
    if (entry.link && existingLinks.has(entry.link)) {
      return false; // already logged on a previous sync — nothing to do
    }

    await client.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Posts!A:D",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[entry.date, entry.platform, entry.summary, entry.link ?? ""]] },
    });

    postsCache = null; // invalidate so the very next customer question sees this, not up to 5 minutes late
    return true;
  } catch (err) {
    console.error("Failed to append new post to Posts sheet:", err);
    return false;
  }
}

export async function getRecentPosts(): Promise<PostEntry[]> {
  if (postsCache && Date.now() - postsCache.at < POSTS_CACHE_TTL_MS) return postsCache.posts;

  const client = getClient();
  if (!client) return [];

  try {
    const res = await client.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: "Posts!A2:D" });
    const rows = (res.data.values as string[][] | undefined) ?? [];
    const posts = rows
      .filter((r) => r[2]) // must at least have a summary
      .map((r) => ({ date: r[0] ?? "", platform: r[1] ?? "", summary: r[2] ?? "", link: r[3] || undefined }))
      .slice(-15); // most recent ~15 is plenty of context without bloating the prompt
    postsCache = { at: Date.now(), posts };
    return posts;
  } catch (err) {
    console.error("Failed to read Posts sheet — recent-posts context will be empty until this resolves:", err);
    return postsCache?.posts ?? [];
  }
}
