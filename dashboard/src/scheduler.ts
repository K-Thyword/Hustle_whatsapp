// A minimal, dependency-free weekly scheduler — checks once an hour
// whether it's time to send the digest, rather than pulling in a cron
// library for a single recurring job. Guards against sending twice in the
// same week by tracking the ISO week number of the last send in memory.
// A service restart right around the send window could in theory cause a
// duplicate or a missed week — an acceptable tradeoff for how infrequently
// this runs and how low-stakes a repeat/missed digest is.
//
// Runs at 8am server time on Mondays. Railway containers run in UTC, and
// Ghana has no daylight saving and sits at UTC+0 year-round, so this lines
// up with 8am Ghana time with no adjustment needed. If agents are ever in
// a different timezone, change SEND_HOUR accordingly.

import { generateWeeklyDigest } from "./digest";
import { sendDigestToAgents, whatsappConfigured } from "./whatsapp";

const SEND_DAY = 1; // Monday (Date#getDay(): 0 = Sunday)
const SEND_HOUR = 8;

function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${weekNo}`;
}

let lastSentWeek: string | null = null;

async function maybeSend() {
  if (!whatsappConfigured()) return; // nothing to do until Meta creds + AGENT_NOTIFY_NUMBERS are set on this service too
  const now = new Date();
  if (now.getDay() !== SEND_DAY || now.getHours() !== SEND_HOUR) return;

  const key = isoWeekKey(now);
  if (key === lastSentWeek) return;
  lastSentWeek = key;

  console.log("Sending weekly digest to agents...");
  const { text } = await generateWeeklyDigest();
  const { sent, failed } = await sendDigestToAgents(text);
  console.log(`Weekly digest: sent to ${sent} agent(s), ${failed} failed.`);
}

export function startWeeklyDigestScheduler() {
  maybeSend(); // in case the service happens to (re)start right in the send window
  setInterval(maybeSend, 60 * 60 * 1000); // check hourly — cheap, no need for minute-level precision
}
