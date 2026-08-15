// One shared password for everyone who's allowed to see this dashboard
// (you + the 3 agents) — no per-user accounts yet, matching the decision
// to keep v1 simple. A session cookie (via express-session) remembers a
// successful login; requireAuth blocks every route except /login until
// one exists.
//
// Deliberately NOT using bcrypt/hashing here: there's exactly one shared
// secret, stored as a Railway env var, never persisted anywhere else — a
// plain compare is enough for that, and pulling in a hashing lib would be
// complexity with nothing real behind it.

import { Request, Response, NextFunction } from "express";

const ADMIN_PASSWORD = process.env.ADMIN_DASHBOARD_PASSWORD;

declare module "express-session" {
  interface SessionData {
    authed?: boolean;
  }
}

export function isConfigured(): boolean {
  return Boolean(ADMIN_PASSWORD);
}

export function checkPassword(attempt: string): boolean {
  if (!ADMIN_PASSWORD) return false;
  return attempt === ADMIN_PASSWORD;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (req.session?.authed) return next();
  if (req.path.startsWith("/api/")) {
    res.status(401).json({ error: "not authenticated" });
    return;
  }
  res.redirect("/login.html");
}
