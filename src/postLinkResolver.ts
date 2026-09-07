// Safely resolves a Facebook/Instagram post link a customer pastes into
// chat (e.g. a "web.facebook.com/share/p/..." share link) into one of OUR
// OWN already-synced posts, so the bot can answer using verified content
// instead of guessing or flatly saying it can't open links.
//
// SECURITY — this module's one job is to never fetch a customer-supplied
// URL directly:
//   - Blindly fetching whatever link a customer pastes is an SSRF risk (the
//     URL could point at an internal address our server can reach but
//     shouldn't — cloud metadata endpoints, internal admin panels, etc.)
//     and a prompt-injection risk (fetched page content becomes untrusted
//     text the model reads, which could contain hidden instructions).
//   - So the pasted URL's hostname is checked against an allowlist of
//     Meta's own domains BEFORE any network call happens. Anything else is
//     rejected outright — no request is made at all.
//   - The only network calls this makes are to graph.facebook.com (Meta's
//     own API, using our own access token — same trust boundary already
//     used by socialPostSync.ts) and to our own Google Sheet. The
//     customer's URL is passed as a query-parameter VALUE to that trusted,
//     fixed-host API — it is never used as a fetch target itself.
//   - The resolved post is only trusted if it matches something already
//     synced from our own Page/IG account (socialPostSync.ts). If Graph
//     can't resolve the link, or it doesn't match anything we've actually
//     published, this returns undefined — callers must treat that as "not
//     recognized," never as a reason to guess or fall back to a raw fetch.

import { PostEntry, getRecentPosts } from "./googleSheet";
import { syncSocialPosts } from "./socialPostSync";

const ACCESS_TOKEN = process.env.INSTAGRAM_ACCESS_TOKEN;
const GRAPH_VERSION = "v26.0";

// Suffix-matched ("host === base" or "host.endsWith('.' + base)") so
// "evil-facebook.com" or "facebook.com.evil.io" can't sneak past this.
const ALLOWED_HOSTS = ["facebook.com", "fb.watch", "instagram.com"];

function isAllowedMetaUrl(candidate: string): URL | undefined {
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") return undefined;
    const host = url.hostname.toLowerCase();
    const allowed = ALLOWED_HOSTS.some((base) => host === base || host.endsWith(`.${base}`));
    return allowed ? url : undefined;
  } catch {
    return undefined;
  }
}

const URL_PATTERN = /https?:\/\/[^\s]+/gi;

// Pulls any Meta-domain URLs out of a free-text message — customers often
// paste a link alongside other words ("check this out: <link>").
function extractMetaUrls(text: string): URL[] {
  const matches = text.match(URL_PATTERN) ?? [];
  return matches.map(isAllowedMetaUrl).filter((u): u is URL => Boolean(u));
}

interface GraphObjectLookup {
  id?: string;
  link?: string;
  error?: { message: string };
}

// Asks Meta's own Graph API to resolve the pasted URL to a Graph object —
// we never fetch the URL ourselves. If Meta doesn't recognize it (private
// post, wrong permissions, or just not resolvable), this returns
// undefined; callers must treat that as "not one of ours."
async function resolveGraphObject(url: URL): Promise<GraphObjectLookup | undefined> {
  if (!ACCESS_TOKEN) return undefined;
  try {
    const lookupUrl =
      `https://graph.facebook.com/${GRAPH_VERSION}/?id=${encodeURIComponent(url.toString())}` +
      `&fields=id,link&access_token=${ACCESS_TOKEN}`;
    const res = await fetch(lookupUrl);
    const body = (await res.json()) as GraphObjectLookup;
    if (!res.ok || body.error || !body.id) return undefined;
    return body;
  } catch (err) {
    console.error("[Post link resolver] Graph object lookup failed:", err);
    return undefined;
  }
}

function findMatch(posts: PostEntry[], resolved: GraphObjectLookup, pastedUrl: URL): PostEntry | undefined {
  return posts.find((p) => {
    if (!p.link) return false;
    if (p.link === pastedUrl.toString()) return true;
    if (resolved.link && p.link === resolved.link) return true;
    if (resolved.id && p.link.includes(resolved.id)) return true;
    return false;
  });
}

// Tries to identify a pasted link as one of our own already-synced posts.
// Returns undefined if it's not a Meta URL, Meta can't resolve it, or it
// doesn't match anything we've actually published — in every one of those
// cases the caller should treat the link as "not recognized" and let the
// bot say so, never substitute a guess.
export async function resolvePostedLink(text: string): Promise<PostEntry | undefined> {
  const urls = extractMetaUrls(text);
  if (urls.length === 0) return undefined;

  const url = urls[0]; // first Meta link mentioned
  const resolved = await resolveGraphObject(url);
  if (!resolved) return undefined;

  let posts = await getRecentPosts();
  let match = findMatch(posts, resolved, url);
  if (match) return match;

  // Might just not be synced yet (see socialPostSync.ts's SYNC_INTERVAL_MS
  // — a post shared minutes ago can lag behind the schedule) — force one
  // immediate sync and check once more before giving up.
  await syncSocialPosts();
  posts = await getRecentPosts();
  return findMatch(posts, resolved, url);
}
