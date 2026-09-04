// Automatically keeps the "Posts" Google Sheet tab (see googleSheet.ts's
// getRecentPosts/appendPostIfNew) in sync with what's actually been posted
// to Instagram, so the bot's recent-posts memory never goes stale even if
// nobody remembers to add a row by hand. Facebook Page posts aren't covered
// here — only Instagram, since that's what the connected access token
// currently has permission to read (see README's "Facebook/Instagram post
// & ad awareness" section for how that token was obtained).
//
// Fully optional — if either env var below is missing, this quietly no-ops
// (same graceful-degradation pattern as every other integration in this
// project), and the manual Posts tab workflow keeps working exactly as
// before.
//
// Setup:
//   INSTAGRAM_ACCESS_TOKEN=<a Page or System User access token with at
//     least instagram_basic + pages_read_engagement>
//   INSTAGRAM_BUSINESS_ACCOUNT_ID=<your Instagram Business Account ID,
//     e.g. from Meta Business Suite or the Graph API Explorer>
//
// A System User token (Business Settings > Users > System users) is
// strongly preferred over a token generated in Graph API Explorer — the
// Explorer's tokens expire (60 days even after "Extend Access Token"),
// while a System User token doesn't, so this won't silently stop working
// on a schedule nobody's watching.

import { appendPostIfNew, PostEntry } from "./googleSheet";

const ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_USER_ID = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
const GRAPH_VERSION = "v26.0";

const isConfigured = Boolean(ACCESS_TOKEN && IG_USER_ID);

interface InstagramMedia {
  id: string;
  caption?: string;
  media_type: string;
  permalink: string;
  timestamp: string;
}

interface MediaResponse {
  data?: InstagramMedia[];
  error?: { message: string };
}

// Turns a raw caption into something short enough to be useful as a Posts
// sheet "Summary" cell — captions are often one strong opening line
// followed by a long pitch/hashtag block, so the first non-empty line is
// usually the actual content; capped so a single verbose post can't blow
// out the prompt this eventually feeds into (see intentRouter.ts's
// postsSection).
function summarize(caption: string | undefined): string {
  if (!caption) return "(no caption)";
  const firstLine = caption
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const text = firstLine ?? caption;
  return text.length > 200 ? text.slice(0, 197) + "..." : text;
}

// Instagram timestamps look like "2026-09-04T13:00:04+0000" — keep just
// the date part, matching the manual Posts tab convention (Date column).
function formatDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

export async function syncInstagramPosts(): Promise<void> {
  if (!isConfigured) {
    console.log(
      "[Instagram sync] Not configured (INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_BUSINESS_ACCOUNT_ID missing) — skipping."
    );
    return;
  }

  try {
    const url =
      `https://graph.facebook.com/${GRAPH_VERSION}/${IG_USER_ID}/media` +
      `?fields=id,caption,media_type,permalink,timestamp&limit=25&access_token=${ACCESS_TOKEN}`;
    const res = await fetch(url);
    const body = (await res.json()) as MediaResponse;

    if (!res.ok || body.error) {
      console.error("[Instagram sync] Graph API error:", body.error?.message ?? res.statusText);
      return;
    }

    const media = body.data ?? [];
    let added = 0;

    // Oldest first, so on the very first run (effectively a backfill) the
    // sheet ends up in chronological order rather than newest-first.
    for (const item of [...media].reverse()) {
      const entry: PostEntry = {
        date: formatDate(item.timestamp),
        platform: "Instagram",
        summary: summarize(item.caption),
        link: item.permalink,
      };
      const wasAdded = await appendPostIfNew(entry);
      if (wasAdded) added++;
    }

    if (added > 0) {
      console.log(`[Instagram sync] Added ${added} new post(s) to the Posts sheet.`);
    }
  } catch (err) {
    console.error("[Instagram sync] Failed to sync posts:", err);
  }
}

// Every 6 hours is frequent enough that a new post shows up in the bot's
// answers the same day it's published, without hammering the Graph API's
// rate limit (which is generous — 200 x account impressions per 24h — so
// this leaves huge headroom for the dashboard or anything else reading
// the same token later).
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function startInstagramSyncScheduler(): void {
  if (!isConfigured) return;
  // Run once shortly after startup — this doubles as a manual trigger
  // while testing, since restarting the bot (or redeploying) kicks off an
  // immediate sync you can watch in the logs — then on a fixed interval.
  syncInstagramPosts();
  setInterval(syncInstagramPosts, SYNC_INTERVAL_MS);
}
