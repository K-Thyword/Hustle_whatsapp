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

import { google } from "googleapis";

const SHEET_ID = process.env.GOOGLE_SHEETS_ID;
const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const SERVICE_ACCOUNT_PRIVATE_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

const isConfigured = Boolean(SHEET_ID && SERVICE_ACCOUNT_EMAIL && SERVICE_ACCOUNT_PRIVATE_KEY);

let sheetsClient: ReturnType<typeof google.sheets> | null = null;

function getClient() {
  if (!isConfigured) return null;
  if (sheetsClient) return sheetsClient;

  const auth = new google.auth.JWT({
    email: SERVICE_ACCOUNT_EMAIL,
    key: (SERVICE_ACCOUNT_PRIVATE_KEY as string).replace(/\\n/g, "\n"),
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
