// Automatically keeps the "Posts" Google Sheet tab (see googleSheet.ts's
// getRecentPosts/appendNewPosts) in sync with what's actually been posted
// on Instagram AND Facebook, so the bot's recent-posts memory never goes
// stale even if nobody remembers to add a row by hand. Covers every
// Instagram media type (images, videos, carousels, Reels) and every
// Facebook Page post — earlier versions of this only pulled the most
// recent 25 Instagram items, which could land entirely on one media type
// and miss others; this paginates through full history instead.
//
// Fully optional — if none of the env vars below are set, this quietly
// no-ops (same graceful-degradation pattern as every other integration in
// this project), and the manual Posts tab workflow keeps working exactly
// as before.
//
// Setup:
//   INSTAGRAM_ACCESS_TOKEN=<a Page or System User access token with at
//     least instagram_basic + pages_read_engagement + business_management>
//   INSTAGRAM_BUSINESS_ACCOUNT_ID=<your Instagram Business Account ID>
//   FACEBOOK_PAGE_ID=<your Facebook Page ID — same token covers this too,
//     since pages_read_engagement already grants read access to the
//     Page's own posts>
// Instagram and Facebook are independent — set either or both.
//
// A System User token (Business Settings > Users > System users) is
// strongly preferred over a token generated in Graph API Explorer — the
// Explorer's tokens expire (60 days even after "Extend Access Token"),
// while a System User token doesn't, so this won't silently stop working
// on a schedule nobody's watching.

import { appendNewPosts, getExistingPostLinks, PostEntry } from "./googleSheet";

const ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const IG_USER_ID = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
const FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID;
const GRAPH_VERSION = "v26.0";

const instagramConfigured = Boolean(ACCESS_TOKEN && IG_USER_ID);
const facebookConfigured = Boolean(ACCESS_TOKEN && FACEBOOK_PAGE_ID);

// Hard cap on how many pages of a source this will walk in one sync run.
// Only matters on the very first run for an account with a long posting
// history (25/page x 20 pages = up to 500 posts backfilled at once) —
// every run after that stops almost immediately, since it exits as soon
// as it reaches a post it's already logged.
const MAX_PAGES_PER_SOURCE = 20;

interface GraphPageResponse<T> {
  data?: T[];
  paging?: { next?: string };
  error?: { message: string };
}

interface InstagramMediaItem {
  id: string;
  caption?: string;
  media_type: string; // IMAGE | VIDEO | CAROUSEL_ALBUM
  media_product_type?: string; // FEED | REELS | STORY | AD
  permalink: string;
  timestamp: string;
}

interface FacebookPostItem {
  id: string;
  message?: string;
  story?: string; // Meta's auto-generated fallback text (e.g. "X added a photo") when there's no caption
  permalink_url: string;
  created_time: string;
}

// Turns a raw caption/message into something short enough to be useful as
// a Posts sheet "Summary" cell — captions are often one strong opening
// line followed by a long pitch/hashtag block, so the first non-empty
// line is usually the actual content; capped so a single verbose post
// can't blow out the prompt this eventually feeds into (see
// intentRouter.ts's postsSection).
function summarize(text: string | undefined): string {
  if (!text) return "(no caption)";
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const clean = firstLine ?? text;
  return clean.length > 200 ? clean.slice(0, 197) + "..." : clean;
}

// Both APIs return timestamps like "2026-09-04T13:00:04+0000" — keep just
// the date part, matching the manual Posts tab convention (Date column).
function formatDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

// Walks a Graph API edge's pagination (newest-first), collecting items
// until it either reaches one already present in the sheet — meaning
// everything older has already been synced — or hits MAX_PAGES_PER_SOURCE.
async function fetchNewItems<T>(
  startUrl: string,
  existingLinks: Set<string>,
  getLink: (item: T) => string
): Promise<T[]> {
  const results: T[] = [];
  let url: string | undefined = startUrl;
  let pages = 0;

  while (url && pages < MAX_PAGES_PER_SOURCE) {
    const res = await fetch(url);
    const body = (await res.json()) as GraphPageResponse<T>;

    if (!res.ok || body.error) {
      console.error("[Social post sync] Graph API error:", body.error?.message ?? res.statusText);
      break;
    }

    for (const item of body.data ?? []) {
      if (existingLinks.has(getLink(item))) return results; // reached already-synced territory
      results.push(item);
    }

    url = body.paging?.next;
    pages++;
  }

  return results;
}

async function fetchInstagramEntries(existingLinks: Set<string>): Promise<PostEntry[]> {
  if (!instagramConfigured) return [];

  const startUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/${IG_USER_ID}/media` +
    `?fields=id,caption,media_type,media_product_type,permalink,timestamp&limit=25&access_token=${ACCESS_TOKEN}`;

  const items = await fetchNewItems<InstagramMediaItem>(startUrl, existingLinks, (item) => item.permalink);

  // Oldest first, so the sheet reads chronologically within each sync
  // batch rather than newest-first.
  return [...items].reverse().map((item) => ({
    date: formatDate(item.timestamp),
    platform: "Instagram",
    summary: summarize(item.caption),
    link: item.permalink,
  }));
}

async function fetchFacebookEntries(existingLinks: Set<string>): Promise<PostEntry[]> {
  if (!facebookConfigured) return [];

  const startUrl =
    `https://graph.facebook.com/${GRAPH_VERSION}/${FACEBOOK_PAGE_ID}/posts` +
    `?fields=id,message,story,permalink_url,created_time&limit=25&access_token=${ACCESS_TOKEN}`;

  const items = await fetchNewItems<FacebookPostItem>(startUrl, existingLinks, (item) => item.permalink_url);

  return [...items].reverse().map((item) => ({
    date: formatDate(item.created_time),
    platform: "Facebook",
    summary: summarize(item.message ?? item.story),
    link: item.permalink_url,
  }));
}

export async function syncSocialPosts(): Promise<void> {
  if (!instagramConfigured && !facebookConfigured) {
    console.log(
      "[Social post sync] Not configured (need INSTAGRAM_ACCESS_TOKEN + " +
        "INSTAGRAM_BUSINESS_ACCOUNT_ID and/or FACEBOOK_PAGE_ID) — skipping."
    );
    return;
  }

  try {
    const existingLinks = await getExistingPostLinks();
    const [igEntries, fbEntries] = await Promise.all([
      fetchInstagramEntries(existingLinks),
      fetchFacebookEntries(existingLinks),
    ]);

    // Everything gathered above is already known-new relative to
    // existingLinks (fetchNewItems stops as soon as it sees a post that
    // isn't), so this is ONE read + ONE write to the Sheets API no matter
    // how many hundred posts a first-time backfill turns up — looping a
    // read+write per post here is what blew through Google's per-minute
    // quota the first time this ran.
    const added = await appendNewPosts([...igEntries, ...fbEntries]);
    if (added > 0) {
      console.log(
        `[Social post sync] Added ${added} new post(s) to the Posts sheet ` +
          `(${igEntries.length} Instagram, ${fbEntries.length} Facebook found).`
      );
    }
  } catch (err) {
    console.error("[Social post sync] Failed to sync posts:", err);
  }
}

// Every 6 hours is frequent enough that a new post shows up in the bot's
// answers the same day it's published, without hammering either API's
// rate limit (Instagram's is generous — 200 x account impressions per
// 24h; Facebook Page reads are similarly generous) — plenty of headroom
// even with two sources polled on the same schedule.
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function startSocialPostSyncScheduler(): void {
  if (!instagramConfigured && !facebookConfigured) return;
  // Run once shortly after startup — this doubles as a manual trigger
  // while testing, since restarting the bot (or redeploying) kicks off an
  // immediate sync you can watch in the logs — then on a fixed interval.
  syncSocialPosts();
  setInterval(syncSocialPosts, SYNC_INTERVAL_MS);
}
