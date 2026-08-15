import "dotenv/config";
import express, { Request, Response } from "express";
import session from "express-session";
import path from "path";
import { requireAuth, checkPassword, isConfigured } from "./auth";
import { api } from "./api";
import { startWeeklyDigestScheduler } from "./scheduler";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-only-insecure-secret-set-SESSION_SECRET-in-env",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 }, // 30 days
  })
);

// Login is the one route that must work before auth exists.
app.post("/api/login", (req: Request, res: Response) => {
  if (!isConfigured()) {
    res.status(500).json({ error: "ADMIN_DASHBOARD_PASSWORD isn't set on the server yet." });
    return;
  }
  const { password } = req.body ?? {};
  if (typeof password === "string" && checkPassword(password)) {
    req.session.authed = true;
    res.json({ ok: true });
    return;
  }
  res.status(401).json({ error: "Wrong password." });
});

app.post("/api/logout", (req: Request, res: Response) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/login.html", (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "..", "public", "login.html"));
});

// Everything else requires a valid session.
app.use(requireAuth);
app.use("/api", api);
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/", (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Hustleapp dashboard running on port ${PORT}`);
  if (!isConfigured()) {
    console.warn("ADMIN_DASHBOARD_PASSWORD is not set — nobody can log in until it is.");
  }
  startWeeklyDigestScheduler();
});
