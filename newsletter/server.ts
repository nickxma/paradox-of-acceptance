/**
 * server.ts — Newsletter Send Pipeline
 *
 * HTTP API for triggering newsletter sends from paradoxofacceptance.xyz.
 * Used by Content Lead or authorized agents to trigger broadcasts via Resend.
 *
 * Usage:
 *   cp .env.example .env  # fill in all vars
 *   npm run server
 *
 * Endpoints:
 *   POST /send                — send newsletter (test or full list) — legacy
 *   POST /api/newsletter/send — send newsletter (admin, with send log)
 *   GET  /health              — health check
 *   GET  /status/:id          — check broadcast status
 *
 * Auth:
 *   /send endpoints use X-Api-Key header
 *   /api/newsletter/send uses X-Admin-Secret header
 *
 * IMPORTANT: Full-list sends are blocked unless ALLOW_FULL_LIST_SEND=true.
 *            Nick must explicitly approve before setting this.
 */

import express, { Request, Response, NextFunction } from "express";
import { Resend } from "resend";
import { marked } from "marked";
import * as cheerio from "cheerio";
import { createHmac, timingSafeEqual } from "crypto";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import PDFDocument from "pdfkit";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

dotenv.config();

// ─── Config ──────────────────────────────────────────────────────────────────

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;
const EMAIL_FROM = process.env.EMAIL_FROM;
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO;
const SEND_API_KEY = process.env.SEND_API_KEY;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const TEST_EMAIL = process.env.TEST_EMAIL;
const UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET;
const SERVER_URL = (process.env.SERVER_URL ?? "https://paradoxofacceptance.xyz").replace(/\/$/, "");
const ALLOW_FULL_LIST_SEND = process.env.ALLOW_FULL_LIST_SEND === "true";
const PORT = parseInt(process.env.PORT || "3200", 10);
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;
const CONVERGENCE_MVP_URL = (process.env.CONVERGENCE_MVP_URL ?? "").replace(/\/$/, "");
const CONVERGENCE_ADMIN_WALLET = process.env.CONVERGENCE_ADMIN_WALLET ?? "";
const PREFERENCES_JWT_SECRET = process.env.PREFERENCES_JWT_SECRET;

// ─── Supabase (optional — for send log) ──────────────────────────────────────

let supabase: SupabaseClient | null = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Validate required config at startup
function validateConfig() {
  const required = ["RESEND_API_KEY", "RESEND_AUDIENCE_ID", "EMAIL_FROM", "SEND_API_KEY", "UNSUBSCRIBE_SECRET"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (!ALLOW_FULL_LIST_SEND) {
    console.warn(
      "⚠️  ALLOW_FULL_LIST_SEND is not set to true — full-list sends are blocked. " +
        "Nick must approve before enabling."
    );
  }
  if (!process.env.SERVER_URL) {
    console.warn("⚠️  SERVER_URL not set — unsubscribe links in welcome emails will use https://paradoxofacceptance.xyz");
  }
  if (!ADMIN_SECRET) {
    console.warn("⚠️  ADMIN_SECRET not set — POST /api/newsletter/send will be disabled");
  }
  if (!supabase) {
    console.warn("⚠️  SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set — send log will not be persisted");
  }
  if (!RESEND_WEBHOOK_SECRET) {
    console.warn("⚠️  RESEND_WEBHOOK_SECRET not set — webhook signature validation is disabled (dev/test only)");
  }
  if (!PREFERENCES_JWT_SECRET) {
    console.warn("⚠️  PREFERENCES_JWT_SECRET not set — /api/email/preferences endpoints will return 503");
  }
}

// ─── Unsubscribe token helpers ────────────────────────────────────────────────

function generateUnsubscribeToken(email: string): string {
  const hmac = createHmac("sha256", UNSUBSCRIBE_SECRET!);
  hmac.update(email.toLowerCase().trim());
  const sig = hmac.digest("hex");
  return Buffer.from(`${email}:${sig}`).toString("base64url");
}

function verifyUnsubscribeToken(token: string): string | null {
  let email: string;
  let sig: string;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const colonIdx = decoded.lastIndexOf(":");
    if (colonIdx === -1) return null;
    email = decoded.slice(0, colonIdx);
    sig = decoded.slice(colonIdx + 1);
  } catch {
    return null;
  }
  const expected = createHmac("sha256", UNSUBSCRIBE_SECRET!).update(email.toLowerCase().trim()).digest("hex");
  try {
    if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return null;
  } catch {
    return null;
  }
  return email;
}

// ─── Preferences JWT helpers ─────────────────────────────────────────────────

const PREFERENCES_TOKEN_TTL_SECS = 30 * 24 * 60 * 60; // 30 days

/**
 * Sign a preferences JWT (HS256) containing the subscriber's email.
 * Returns a compact base64url-encoded token.
 */
function signPreferencesToken(email: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ sub: email.toLowerCase().trim(), iat: now, exp: now + PREFERENCES_TOKEN_TTL_SECS })
  ).toString("base64url");
  const sig = createHmac("sha256", PREFERENCES_JWT_SECRET!)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

type PreferencesTokenResult =
  | { ok: true; email: string; expired: false }
  | { ok: false; email?: never; expired: boolean };

/**
 * Verify a preferences JWT. Returns the subscriber email or an error state.
 */
function verifyPreferencesToken(token: string): PreferencesTokenResult {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, expired: false };
    const [header, payload, sig] = parts;
    const expected = createHmac("sha256", PREFERENCES_JWT_SECRET!)
      .update(`${header}.${payload}`)
      .digest("base64url");
    const sigBuf = Buffer.from(sig, "base64url");
    const expBuf = Buffer.from(expected, "base64url");
    if (sigBuf.length !== expBuf.length) return { ok: false, expired: false };
    if (!timingSafeEqual(sigBuf, expBuf)) return { ok: false, expired: false };
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof data.sub !== "string") return { ok: false, expired: false };
    if (data.exp < Math.floor(Date.now() / 1000)) return { ok: false, expired: true };
    return { ok: true, email: data.sub, expired: false };
  } catch {
    return { ok: false, expired: false };
  }
}

// ─── Resend webhook signature verification ───────────────────────────────────

/**
 * Verify the svix-signature header on incoming Resend webhook requests.
 * Returns true if valid (or if RESEND_WEBHOOK_SECRET is not set — dev/test mode).
 * Always returns false if the secret is set but the signature is missing or wrong.
 */
function verifyResendWebhookSignature(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean {
  if (!RESEND_WEBHOOK_SECRET) return true; // Allow unsigned in dev/test

  const svixId = String(headers["svix-id"] ?? "");
  const svixTs = String(headers["svix-timestamp"] ?? "");
  const svixSig = String(headers["svix-signature"] ?? "");
  if (!svixId || !svixTs || !svixSig) return false;

  const toSign = `${svixId}.${svixTs}.${rawBody}`;

  // Resend signing secrets are prefixed "whsec_" — the actual key is base64-decoded bytes after the prefix
  const secretBytes = RESEND_WEBHOOK_SECRET.startsWith("whsec_")
    ? Buffer.from(RESEND_WEBHOOK_SECRET.slice("whsec_".length), "base64")
    : Buffer.from(RESEND_WEBHOOK_SECRET);

  const expected = createHmac("sha256", secretBytes).update(toSign).digest("base64");

  // svix-signature header is space-separated "v1,<base64sig>" values
  return svixSig.split(" ").some((s) => s.replace(/^v\d+,/, "") === expected);
}

// ─── App ─────────────────────────────────────────────────────────────────────

const app = express();

// Capture raw body for webhook signature verification
app.use(express.json({
  limit: "2mb",
  verify: (_req, _res, buf) => {
    (_req as any).rawBody = buf.toString("utf8");
  },
}));

// Request logger
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// ─── Auth middleware ──────────────────────────────────────────────────────────

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const key = req.headers["x-api-key"];
  if (!key || key !== SEND_API_KEY) {
    res.status(401).json({ error: "Unauthorized — invalid or missing X-Api-Key header" });
    return;
  }
  next();
}

function requireAdminSecret(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_SECRET) {
    res.status(503).json({ error: "ADMIN_SECRET not configured — endpoint unavailable" });
    return;
  }
  const secret = req.headers["x-admin-secret"];
  if (!secret || secret !== ADMIN_SECRET) {
    res.status(401).json({ error: "Unauthorized — invalid or missing X-Admin-Secret header" });
    return;
  }
  next();
}

// ─── Send log ─────────────────────────────────────────────────────────────────

type SendLogEntry = {
  subject: string;
  sentAt: Date;
  recipientCount: number;
  testMode: boolean;
  broadcastId?: string;
  emailId?: string;
  status: "sent" | "failed";
  error?: string;
  previewText?: string;
  bodyHtml?: string;
  bodyText?: string;
  includeInArchive?: boolean;
};

async function logSend(entry: SendLogEntry): Promise<void> {
  console.log(`[send-log] subject="${entry.subject}" mode=${entry.testMode ? "test" : "live"} recipients=${entry.recipientCount} status=${entry.status}`);

  if (!supabase) {
    console.warn("[send-log] Supabase not configured — skipping DB write");
    return;
  }

  const { error } = await supabase.from("newsletter_sends").insert({
    subject: entry.subject,
    sent_at: entry.sentAt.toISOString(),
    recipient_count: entry.recipientCount,
    test_mode: entry.testMode,
    broadcast_id: entry.broadcastId ?? null,
    email_id: entry.emailId ?? null,
    status: entry.status,
    error: entry.error ?? null,
    preview_text: entry.previewText ?? null,
    body_html: entry.bodyHtml ?? null,
    body_text: entry.bodyText ?? null,
    include_in_archive: entry.includeInArchive ?? true,
  });

  if (error) {
    console.error("[send-log] Failed to write to newsletter_sends:", error);
  }
}

// ─── Content fetching ─────────────────────────────────────────────────────────

/**
 * Fetch essay HTML from a paradoxofacceptance.xyz URL.
 * Extracts <article> content, falling back to <main> or <body>.
 */
async function fetchEssayFromUrl(url: string): Promise<{ html: string; title: string }> {
  const response = await fetch(url, {
    headers: { "User-Agent": "newsletter-pipeline/1.0" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }

  const rawHtml = await response.text();
  const $ = cheerio.load(rawHtml);

  // Extract title
  const title = $("title").text().trim() || $("h1").first().text().trim();

  // Extract article body — prefer <article>, fall back to <main>, then <body>
  let content = $("article").first();
  if (!content.length) content = $("main").first();
  if (!content.length) content = $("body");

  // Remove nav, footer, scripts, and interactive elements from the extract
  content.find("nav, footer, script, style, .back-nav, .toc-sidebar, #progress-bar").remove();

  const html = content.html()?.trim() || "";
  if (!html) throw new Error("Could not extract article content from URL");

  return { html, title };
}

/**
 * Convert markdown to email-friendly HTML.
 * Wraps in a minimal inline-styled container for email clients.
 */
async function markdownToEmailHtml(markdown: string): Promise<string> {
  const bodyHtml = await marked(markdown, { async: true });
  return wrapEmailHtml(bodyHtml);
}

function wrapEmailHtml(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Paradox of Acceptance</title>
</head>
<body style="margin:0;padding:0;background:#faf8f4;font-family:Georgia,'Times New Roman',serif;">
  <div style="max-width:640px;margin:0 auto;padding:48px 24px;color:#2c2c2c;font-size:18px;line-height:1.8;">
    ${bodyHtml}
    <hr style="margin:48px 0;border:none;border-top:1px solid #e2ddd6;" />
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;color:#999;line-height:1.5;">
      You're receiving this because you subscribed to the Paradox of Acceptance newsletter.<br/>
      <a href="{{manage_preferences}}" style="color:#7d8c6e;">Manage preferences</a> &nbsp;·&nbsp;
      <a href="{{unsubscribe}}" style="color:#7d8c6e;">Unsubscribe</a>
    </p>
  </div>
</body>
</html>`;
}

// ─── Send logic ───────────────────────────────────────────────────────────────

type SendResult =
  | { status: "sent"; mode: "test"; emailId: string; subject: string }
  | { status: "sent"; mode: "broadcast"; broadcastId: string; subject: string }
  | { status: "error"; error: string; detail?: unknown };

async function sendTestEmail(resend: Resend, opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<SendResult> {
  const { data, error } = await resend.emails.send({
    from: EMAIL_FROM!,
    to: opts.to,
    replyTo: EMAIL_REPLY_TO || undefined,
    subject: `[TEST] ${opts.subject}`,
    html: opts.html,
  });

  if (error || !data) {
    return { status: "error", error: "Test email send failed", detail: error };
  }

  return { status: "sent", mode: "test", emailId: data.id, subject: opts.subject };
}

async function sendBroadcast(resend: Resend, opts: {
  subject: string;
  html: string;
}): Promise<SendResult> {
  // Create the broadcast
  const { data: broadcast, error: createError } = await (resend as any).broadcasts.create({
    audienceId: RESEND_AUDIENCE_ID!,
    from: EMAIL_FROM!,
    replyTo: EMAIL_REPLY_TO || undefined,
    subject: opts.subject,
    html: opts.html,
  });

  if (createError || !broadcast) {
    return { status: "error", error: "Broadcast create failed", detail: createError };
  }

  console.log(`[broadcast] Created: ${broadcast.id}`);

  // Send the broadcast
  const { error: sendError } = await (resend as any).broadcasts.send(broadcast.id);

  if (sendError) {
    return {
      status: "error",
      error: "Broadcast send failed (broadcast created but not sent)",
      detail: { sendError, broadcastId: broadcast.id },
    };
  }

  console.log(`[broadcast] Sent: ${broadcast.id} — subject: "${opts.subject}"`);
  return { status: "sent", mode: "broadcast", broadcastId: broadcast.id, subject: opts.subject };
}

// ─── Welcome email ────────────────────────────────────────────────────────────

function buildWelcomeHtml(email: string, unsubscribeToken: string): string {
  const unsubscribeUrl = `${SERVER_URL}/api/unsubscribe?token=${unsubscribeToken}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Welcome to Paradox of Acceptance</title>
</head>
<body style="margin:0;padding:0;background:#faf8f4;font-family:Georgia,'Times New Roman',serif;">
  <div style="max-width:640px;margin:0 auto;padding:48px 24px;color:#2c2c2c;font-size:18px;line-height:1.8;">
    <p style="margin:0 0 24px;">Welcome.</p>
    <p style="margin:0 0 24px;">
      You've subscribed to <em>Paradox of Acceptance</em> — essays and tools for the questions
      meditation practice raises. The ones that don't have clean answers.
    </p>
    <p style="margin:0 0 24px;">
      You'll hear from me when I have something worth saying: a new essay, a reflection,
      or an experiment worth sharing. No filler, no schedule for its own sake.
    </p>
    <p style="margin:0 0 40px;">
      In the meantime, the site has everything published so far:
    </p>
    <p style="margin:0 0 40px;">
      <a href="https://paradoxofacceptance.xyz"
         style="display:inline-block;background:#2c2c2c;color:#faf8f4;text-decoration:none;padding:12px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:500;border-radius:4px;">
        Browse the archive
      </a>
    </p>
    <hr style="margin:48px 0;border:none;border-top:1px solid #e2ddd6;" />
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;color:#999;line-height:1.5;">
      You're receiving this because you subscribed at paradoxofacceptance.xyz.<br/>
      <a href="${unsubscribeUrl}" style="color:#7d8c6e;">Unsubscribe</a>
    </p>
  </div>
</body>
</html>`;
}

async function sendWelcomeEmail(resend: Resend, email: string, firstName?: string): Promise<void> {
  const token = generateUnsubscribeToken(email);
  const html = buildWelcomeHtml(email, token);
  const greeting = firstName ? `${firstName.trim()},` : "";
  const subject = greeting ? `Welcome, ${firstName?.trim()}` : "Welcome to Paradox of Acceptance";

  const { error } = await resend.emails.send({
    from: EMAIL_FROM!,
    to: email,
    replyTo: EMAIL_REPLY_TO || undefined,
    subject,
    html,
  });

  if (error) {
    console.error(`[subscribe] Welcome email failed for ${email}:`, error);
  } else {
    console.log(`[subscribe] Welcome email sent to ${email}`);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/subscribe
 *
 * Public — no API key required.
 *
 * Body (JSON):
 *   email      {string}  — required
 *   firstName  {string}  — optional
 *
 * Adds the contact to the Resend audience and returns a confirmation.
 * Safe to call for existing subscribers — Resend deduplicates by email.
 */
app.post("/api/subscribe", async (req: Request, res: Response) => {
  const { email, firstName } = req.body as { email?: string; firstName?: string };

  if (!email || !email.includes("@")) {
    res.status(400).json({ error: "Valid email is required" });
    return;
  }

  const resend = new Resend(RESEND_API_KEY!);

  const { error } = await resend.contacts.create({
    audienceId: RESEND_AUDIENCE_ID!,
    email: email.toLowerCase().trim(),
    firstName: firstName?.trim() || undefined,
    unsubscribed: false,
  });

  if (error) {
    console.error(`[subscribe] Error for ${email}:`, error);
    res.status(500).json({ error: "Subscription failed", detail: error });
    return;
  }

  const token = generateUnsubscribeToken(email);
  console.log(`[subscribe] ${email} added to audience`);

  // Send welcome email (non-blocking — don't delay the response)
  sendWelcomeEmail(resend, email.toLowerCase().trim(), firstName).catch((err) => {
    console.error(`[subscribe] Unexpected welcome email error for ${email}:`, err);
  });

  res.json({ status: "subscribed", unsubscribeToken: token });
});

/**
 * GET /api/unsubscribe?token=
 *
 * Public — validates HMAC token, marks contact as unsubscribed in Resend.
 *
 * Token is generated by POST /api/subscribe and embedded in email links.
 * Returns a simple HTML confirmation page suitable for redirect from email clients.
 */
app.get("/api/unsubscribe", async (req: Request, res: Response) => {
  const { token } = req.query as { token?: string };

  if (!token) {
    res.status(400).send("Missing unsubscribe token.");
    return;
  }

  const email = verifyUnsubscribeToken(token);
  if (!email) {
    res.status(400).send("Invalid or tampered unsubscribe token.");
    return;
  }

  const resend = new Resend(RESEND_API_KEY!);

  // Find the contact by email to get their ID
  const { data: contacts, error: listError } = await resend.contacts.list({ audienceId: RESEND_AUDIENCE_ID! });
  if (listError) {
    console.error(`[unsubscribe] Failed to list contacts for ${email}:`, listError);
    res.status(500).send("Unsubscribe failed — please try again later.");
    return;
  }

  const contact = contacts?.data?.find((c: { email: string }) => c.email.toLowerCase() === email.toLowerCase());
  if (!contact) {
    // Contact not found — treat as already unsubscribed
    console.log(`[unsubscribe] ${email} not found in audience (already removed or never subscribed)`);
    res.send(unsubscribeSuccessPage(email));
    return;
  }

  const { error: updateError } = await resend.contacts.update({
    audienceId: RESEND_AUDIENCE_ID!,
    id: contact.id,
    unsubscribed: true,
  });

  if (updateError) {
    console.error(`[unsubscribe] Failed to unsubscribe ${email}:`, updateError);
    res.status(500).send("Unsubscribe failed — please try again later.");
    return;
  }

  console.log(`[unsubscribe] ${email} marked as unsubscribed`);
  res.send(unsubscribeSuccessPage(email));
});

function unsubscribeSuccessPage(email: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Unsubscribed — Paradox of Acceptance</title>
  <style>
    body { margin: 0; padding: 0; background: #faf8f4; font-family: Georgia, serif; }
    .container { max-width: 480px; margin: 80px auto; padding: 0 24px; text-align: center; color: #2c2c2c; }
    h1 { font-size: 24px; margin-bottom: 16px; }
    p { font-size: 16px; line-height: 1.7; color: #666; }
    a { color: #7d8c6e; }
  </style>
</head>
<body>
  <div class="container">
    <h1>You're unsubscribed</h1>
    <p>${email} has been removed from the Paradox of Acceptance newsletter.</p>
    <p><a href="https://paradoxofacceptance.xyz">Return to site</a></p>
  </div>
</body>
</html>`;
}

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    allowFullListSend: ALLOW_FULL_LIST_SEND,
    audienceId: RESEND_AUDIENCE_ID,
  });
});

/**
 * POST /send
 *
 * Body (JSON):
 *   essayUrl     {string}  — URL of essay on paradoxofacceptance.xyz to fetch
 *   markdownBody {string}  — Markdown content to send directly
 *   subject      {string}  — Email subject line (required)
 *   testEmail    {string}  — If set, sends only to this address (test mode)
 *
 * One of essayUrl or markdownBody is required.
 * subject is required.
 *
 * Full-list sends require ALLOW_FULL_LIST_SEND=true in .env.
 */
app.post("/send", requireApiKey, async (req: Request, res: Response) => {
  const { essayUrl, markdownBody, subject, testEmail } = req.body as {
    essayUrl?: string;
    markdownBody?: string;
    subject?: string;
    testEmail?: string;
  };

  // Validate input
  if (!essayUrl && !markdownBody) {
    res.status(400).json({ error: "One of essayUrl or markdownBody is required" });
    return;
  }
  if (!subject) {
    res.status(400).json({ error: "subject is required" });
    return;
  }
  if (!testEmail && !ALLOW_FULL_LIST_SEND) {
    res.status(403).json({
      error:
        "Full-list send is blocked. Set ALLOW_FULL_LIST_SEND=true in .env after Nick approves the send.",
    });
    return;
  }

  const resend = new Resend(RESEND_API_KEY!);

  // Get HTML content
  let html: string;
  try {
    if (essayUrl) {
      console.log(`[content] Fetching essay from: ${essayUrl}`);
      const { html: articleHtml } = await fetchEssayFromUrl(essayUrl);
      html = wrapEmailHtml(articleHtml);
    } else {
      console.log(`[content] Converting markdown body`);
      html = await markdownToEmailHtml(markdownBody!);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[content] Error: ${msg}`);
    res.status(500).json({ error: "Failed to get content", detail: msg });
    return;
  }

  // Send
  let result: SendResult;
  if (testEmail) {
    console.log(`[send] Test send to: ${testEmail}`);
    result = await sendTestEmail(resend, { to: testEmail, subject, html });
  } else {
    console.log(`[send] Broadcast to full audience: "${subject}"`);
    result = await sendBroadcast(resend, { subject, html });
  }

  if (result.status === "error") {
    console.error(`[send] Error: ${result.error}`, result.detail);
    res.status(500).json(result);
    return;
  }

  console.log(`[send] Success:`, result);
  res.json(result);
});

/**
 * GET /status/:broadcastId
 *
 * Check the delivery status of a broadcast.
 * Resend processes broadcasts async — use this to check after sending.
 */
app.get("/status/:broadcastId", requireApiKey, async (req: Request, res: Response) => {
  const { broadcastId } = req.params;
  const resend = new Resend(RESEND_API_KEY!);

  try {
    const { data, error } = await (resend as any).broadcasts.get(broadcastId);
    if (error) {
      res.status(500).json({ error: "Failed to fetch broadcast status", detail: error });
      return;
    }
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── POST /api/newsletter/send ────────────────────────────────────────────────

/**
 * Fetch subscriber_ids (emails) that have opted out of a specific send category.
 * Returns an empty Set if Supabase is not configured (send proceeds to everyone).
 */
async function fetchOptOuts(category: "weekly_digest" | "newsletter" | "course_updates"): Promise<Set<string>> {
  if (!supabase) return new Set();
  const { data, error } = await supabase
    .from("subscriber_preferences")
    .select("subscriber_id")
    .eq(category, false);
  if (error) {
    console.warn(`[preferences] Failed to fetch opt-outs for ${category}:`, error);
    return new Set();
  }
  return new Set((data ?? []).map((row: { subscriber_id: string }) => row.subscriber_id.toLowerCase()));
}

/**
 * Fetch all subscribed contacts from the Resend audience.
 * Handles pagination automatically.
 */
async function fetchAllAudienceContacts(resend: Resend): Promise<Array<{ email: string; firstName?: string }>> {
  // Resend's contacts.list doesn't paginate the same way for large audiences;
  // we fetch the full list and filter to subscribed contacts only.
  const { data, error } = await resend.contacts.list({ audienceId: RESEND_AUDIENCE_ID! });
  if (error || !data?.data) {
    throw new Error(`Failed to fetch audience contacts: ${JSON.stringify(error)}`);
  }
  return (data.data as Array<{ email: string; firstName?: string; unsubscribed: boolean }>)
    .filter((c) => !c.unsubscribed)
    .map((c) => ({ email: c.email, firstName: c.firstName }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send emails in batches of up to 100 via resend.batch.send().
 * Each recipient gets an individually addressed email with their own unsubscribe link.
 * Returns total sent count and error count.
 */
async function sendBatched(
  resend: Resend,
  contacts: Array<{ email: string; firstName?: string }>,
  opts: { subject: string; html: string; text?: string }
): Promise<{ sent: number; errors: number }> {
  const BATCH_SIZE = 100;
  const DELAY_MS = 500;
  let sent = 0;
  let errors = 0;

  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    const batch = contacts.slice(i, i + BATCH_SIZE);

    const emails = batch.map((contact) => {
      const unsubToken = generateUnsubscribeToken(contact.email);
      const unsubscribeUrl = `${SERVER_URL}/api/unsubscribe?token=${unsubToken}`;
      let personalizedHtml = opts.html.replace(/\{\{unsubscribe\}\}/g, unsubscribeUrl);

      if (PREFERENCES_JWT_SECRET) {
        const prefToken = signPreferencesToken(contact.email);
        const prefUrl = `${SERVER_URL}/email/preferences/?token=${prefToken}`;
        personalizedHtml = personalizedHtml.replace(/\{\{manage_preferences\}\}/g, prefUrl);
      } else {
        // Strip the placeholder so it doesn't appear as raw text
        personalizedHtml = personalizedHtml.replace(/\{\{manage_preferences\}\}/g, "#");
      }

      return {
        from: EMAIL_FROM!,
        to: contact.email,
        replyTo: EMAIL_REPLY_TO || undefined,
        subject: opts.subject,
        html: personalizedHtml,
        text: opts.text,
      };
    });

    try {
      const { data, error } = await resend.batch.send(emails as any);
      if (error) {
        console.error(`[batch] Batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, error);
        errors += batch.length;
      } else {
        const batchSent = Array.isArray(data) ? data.length : batch.length;
        sent += batchSent;
        console.log(`[batch] Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(contacts.length / BATCH_SIZE)} — sent ${batchSent}`);
      }
    } catch (err) {
      console.error(`[batch] Batch ${Math.floor(i / BATCH_SIZE) + 1} threw:`, err);
      errors += batch.length;
    }

    // Delay between batches (skip after the last batch)
    if (i + BATCH_SIZE < contacts.length) {
      await sleep(DELAY_MS);
    }
  }

  return { sent, errors };
}

/**
 * POST /api/newsletter/send
 *
 * Admin-only endpoint for broadcasting newsletters.
 * Auth: X-Admin-Secret header must match ADMIN_SECRET env var.
 *
 * Body (JSON):
 *   subject    {string}   — Email subject line (required)
 *   htmlBody   {string}   — Full HTML content (required)
 *   textBody   {string}   — Plain text fallback (optional)
 *   testMode   {boolean}  — If true, sends to TEST_EMAIL only (default: false)
 *
 * Use {{unsubscribe}} in htmlBody — it will be replaced with each recipient's
 * HMAC-signed unsubscribe URL.
 *
 * Full-list sends require ALLOW_FULL_LIST_SEND=true in .env.
 */
app.post("/api/newsletter/send", requireAdminSecret, async (req: Request, res: Response) => {
  const { subject, htmlBody, textBody, testMode, sendType, previewText, includeInArchive } = req.body as {
    subject?: string;
    htmlBody?: string;
    textBody?: string;
    testMode?: boolean;
    sendType?: "newsletter" | "weekly_digest" | "course_updates";
    previewText?: string;
    includeInArchive?: boolean;
  };

  if (!subject?.trim()) {
    res.status(400).json({ error: "subject is required" });
    return;
  }
  if (!htmlBody?.trim()) {
    res.status(400).json({ error: "htmlBody is required" });
    return;
  }

  const isTestMode = testMode === true;

  if (!isTestMode && !ALLOW_FULL_LIST_SEND) {
    res.status(403).json({
      error: "Full-list send is blocked. Set ALLOW_FULL_LIST_SEND=true in .env after Nick approves.",
    });
    return;
  }

  if (isTestMode && !TEST_EMAIL) {
    res.status(500).json({ error: "TEST_EMAIL env var is not configured" });
    return;
  }

  const resend = new Resend(RESEND_API_KEY!);

  // ── Test mode ────────────────────────────────────────────────────────────────
  if (isTestMode) {
    const token = generateUnsubscribeToken(TEST_EMAIL!);
    const unsubscribeUrl = `${SERVER_URL}/api/unsubscribe?token=${token}`;
    const html = htmlBody.replace(/\{\{unsubscribe\}\}/g, unsubscribeUrl);

    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM!,
      to: TEST_EMAIL!,
      replyTo: EMAIL_REPLY_TO || undefined,
      subject: `[TEST] ${subject}`,
      html,
      text: textBody,
    });

    const logEntry: SendLogEntry = {
      subject,
      sentAt: new Date(),
      recipientCount: 1,
      testMode: true,
      status: error ? "failed" : "sent",
      emailId: data?.id,
      error: error ? JSON.stringify(error) : undefined,
      previewText: previewText?.trim() || undefined,
      bodyHtml: htmlBody,
      bodyText: textBody,
      includeInArchive: includeInArchive ?? true,
    };
    await logSend(logEntry);

    if (error || !data) {
      res.status(500).json({ error: "Test send failed", detail: error });
      return;
    }

    res.json({ status: "sent", mode: "test", emailId: data.id, to: TEST_EMAIL, subject });
    return;
  }

  // ── Live mode — batch send to full audience ───────────────────────────────
  let contacts: Array<{ email: string; firstName?: string }>;
  try {
    contacts = await fetchAllAudienceContacts(resend);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[newsletter/send] Failed to fetch contacts:", msg);
    res.status(500).json({ error: "Failed to fetch audience contacts", detail: msg });
    return;
  }

  // Filter out subscribers who opted out of this send category
  const category = (sendType ?? "newsletter") as "newsletter" | "weekly_digest" | "course_updates";
  const optOuts = await fetchOptOuts(category);
  if (optOuts.size > 0) {
    const before = contacts.length;
    contacts = contacts.filter((c) => !optOuts.has(c.email.toLowerCase()));
    console.log(`[newsletter/send] Filtered ${before - contacts.length} opt-outs for category="${category}" — ${contacts.length} remaining`);
  }

  console.log(`[newsletter/send] Starting broadcast to ${contacts.length} subscribers — "${subject}"`);

  const { sent, errors } = await sendBatched(resend, contacts, {
    subject,
    html: htmlBody,
    text: textBody,
  });

  const logEntry: SendLogEntry = {
    subject,
    sentAt: new Date(),
    recipientCount: sent,
    testMode: false,
    status: errors === contacts.length ? "failed" : "sent",
    error: errors > 0 ? `${errors} batches failed out of ${contacts.length} recipients` : undefined,
    previewText: previewText?.trim() || undefined,
    bodyHtml: htmlBody,
    bodyText: textBody,
    includeInArchive: includeInArchive ?? true,
  };
  await logSend(logEntry);

  console.log(`[newsletter/send] Done — sent: ${sent}, errors: ${errors}`);
  res.json({
    status: errors === contacts.length ? "failed" : "sent",
    mode: "broadcast",
    subject,
    recipientCount: contacts.length,
    sent,
    errors,
  });
});

// ─── GET /api/newsletter/stats ────────────────────────────────────────────────

/**
 * GET /api/newsletter/stats
 *
 * Returns subscriber count from the Resend audience.
 * Auth: X-Admin-Secret header.
 */
app.get("/api/newsletter/stats", requireAdminSecret, async (_req: Request, res: Response) => {
  const resend = new Resend(RESEND_API_KEY!);
  const { data, error } = await resend.contacts.list({ audienceId: RESEND_AUDIENCE_ID! });
  if (error || !data?.data) {
    res.status(500).json({ error: "Failed to fetch subscribers", detail: error });
    return;
  }

  type Contact = { unsubscribed: boolean; createdAt?: string; email?: string };
  const contacts = data.data as Contact[];
  const active = contacts.filter((c) => !c.unsubscribed);
  const now = Date.now();
  const day7 = now - 7 * 24 * 60 * 60 * 1000;
  const day30 = now - 30 * 24 * 60 * 60 * 1000;

  const newLast7Days = active.filter((c) => c.createdAt && new Date(c.createdAt).getTime() >= day7).length;
  const newLast30Days = active.filter((c) => c.createdAt && new Date(c.createdAt).getTime() >= day30).length;

  res.json({ subscriberCount: active.length, newLast7Days, newLast30Days });
});

// ─── GET /api/newsletter/subscribers ─────────────────────────────────────────

/**
 * GET /api/newsletter/subscribers
 *
 * Returns the 20 most recently added subscribers with masked email and date.
 * Auth: X-Admin-Secret header.
 */
app.get("/api/newsletter/subscribers", requireAdminSecret, async (_req: Request, res: Response) => {
  const resend = new Resend(RESEND_API_KEY!);
  const { data, error } = await resend.contacts.list({ audienceId: RESEND_AUDIENCE_ID! });
  if (error || !data?.data) {
    res.status(500).json({ error: "Failed to fetch subscribers", detail: error });
    return;
  }

  type Contact = { unsubscribed: boolean; createdAt?: string; email?: string };
  const contacts = (data.data as Contact[]).filter((c) => !c.unsubscribed);

  contacts.sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });

  const recent = contacts.slice(0, 20).map((c) => {
    let masked = "***";
    if (c.email) {
      const atIdx = c.email.lastIndexOf("@");
      const local = atIdx > -1 ? c.email.slice(0, atIdx) : c.email;
      const domain = atIdx > -1 ? c.email.slice(atIdx + 1) : "";
      const prefix = local.length > 2 ? local.slice(0, 2) + "***" : local[0] + "***";
      masked = domain ? `${prefix}@${domain}` : prefix;
    }
    return { email: masked, subscribedAt: c.createdAt ?? null };
  });

  res.json({ subscribers: recent });
});

// ─── GET /api/newsletter/sends ────────────────────────────────────────────────

/**
 * GET /api/newsletter/sends
 *
 * Returns the 20 most recent entries from newsletter_sends (Supabase).
 * Auth: X-Admin-Secret header.
 */
app.get("/api/newsletter/sends", requireAdminSecret, async (_req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured — send history unavailable" });
    return;
  }
  const { data, error } = await supabase
    .from("newsletter_sends")
    .select("id, subject, sent_at, recipient_count, test_mode, broadcast_id, status, error")
    .order("sent_at", { ascending: false })
    .limit(20);
  if (error) {
    res.status(500).json({ error: "Failed to fetch send history", detail: error });
    return;
  }
  res.json({ sends: data ?? [] });
});

// ─── GET /api/newsletter/archive ──────────────────────────────────────────────

/**
 * GET /api/newsletter/archive
 *
 * Public endpoint. Returns list of past newsletter issues in the public archive.
 * Omits body_html, body_text, and open_rate (privacy).
 * Only returns non-test, sent, include_in_archive=true rows.
 */
app.options("/api/newsletter/archive", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

app.get("/api/newsletter/archive", async (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }

  const { data, error } = await supabase
    .from("newsletter_sends")
    .select("id, subject, preview_text, sent_at, recipient_count")
    .eq("test_mode", false)
    .eq("status", "sent")
    .eq("include_in_archive", true)
    .order("sent_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: "Failed to fetch archive", detail: error });
    return;
  }

  res.json({ issues: data ?? [] });
});

// ─── GET /api/newsletter/archive/:id ──────────────────────────────────────────

/**
 * GET /api/newsletter/archive/:id
 *
 * Public endpoint. Returns the full HTML body of a past newsletter issue.
 * Only serves rows that are non-test, sent, and include_in_archive=true.
 */
app.options("/api/newsletter/archive/:id", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

app.get("/api/newsletter/archive/:id", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }

  const { id } = req.params;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    res.status(400).json({ error: "Invalid issue id" });
    return;
  }

  const { data, error } = await supabase
    .from("newsletter_sends")
    .select("id, subject, preview_text, sent_at, recipient_count, body_html, body_text")
    .eq("id", id)
    .eq("test_mode", false)
    .eq("status", "sent")
    .eq("include_in_archive", true)
    .single();

  if (error || !data) {
    res.status(404).json({ error: "Issue not found" });
    return;
  }

  res.json(data);
});

// ─── POST /api/track-view ─────────────────────────────────────────────────────

/**
 * POST /api/track-view
 *
 * Increments the page view counter for an essay slug.
 * Body: { slug: string }
 * No auth required — called from public essay pages.
 * Persists to Supabase page_views table if configured; falls back to in-memory.
 */

// In-memory fallback store (resets on server restart)
const pageViewsMemory = new Map<string, number>();

// CORS pre-flight for track-view (called from the static site)
app.options("/api/track-view", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

app.post("/api/track-view", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { slug } = req.body ?? {};
  if (!slug || typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) {
    res.status(400).json({ error: "Invalid or missing slug" });
    return;
  }

  if (supabase) {
    const { error } = await supabase.rpc("increment_page_view", { p_slug: slug });
    if (error) {
      console.error("[track-view] Supabase error:", error);
      // Fall through to in-memory on failure
      pageViewsMemory.set(slug, (pageViewsMemory.get(slug) ?? 0) + 1);
    }
  } else {
    pageViewsMemory.set(slug, (pageViewsMemory.get(slug) ?? 0) + 1);
  }

  res.json({ ok: true });
});

// ─── GET /api/essays/stats ────────────────────────────────────────────────────

/**
 * GET /api/essays/stats
 *
 * Returns a list of essays with their page view counts, sorted by views desc.
 * Auth: X-Admin-Secret header.
 */

const ESSAYS = [
  { slug: "paradox-of-acceptance", title: "The Paradox of Acceptance", path: "/mindfulness-essays/paradox-of-acceptance/" },
  { slug: "should-you-get-into-mindfulness", title: "Should You Get Into Mindfulness?", path: "/mindfulness-essays/should-you-get-into-mindfulness/" },
  { slug: "the-avoidance-problem", title: "The Avoidance Problem", path: "/mindfulness-essays/the-avoidance-problem/" },
  { slug: "the-cherry-picking-problem", title: "The Cherry-Picking Problem", path: "/mindfulness-essays/the-cherry-picking-problem/" },
  { slug: "when-to-quit", title: "When to Quit", path: "/mindfulness-essays/when-to-quit/" },
];

app.get("/api/essays/stats", requireAdminSecret, async (_req: Request, res: Response) => {
  let viewsMap: Record<string, number> = {};

  if (supabase) {
    const slugs = ESSAYS.map((e) => e.slug);
    const { data, error } = await supabase
      .from("page_views")
      .select("slug, views")
      .in("slug", slugs);
    if (!error && data) {
      for (const row of data as Array<{ slug: string; views: number }>) {
        viewsMap[row.slug] = row.views;
      }
    }
  } else {
    for (const [slug, views] of pageViewsMemory) {
      viewsMap[slug] = views;
    }
  }

  const essays = ESSAYS.map((e) => ({ ...e, views: viewsMap[e.slug] ?? 0 }));
  essays.sort((a, b) => b.views - a.views);

  res.json({ essays });
});

// ─── GET /api/admin/essays  ───────────────────────────────────────────────────

/**
 * GET /api/admin/essays
 *
 * Returns all essays with their publishing status, ordered by published_at desc
 * then created_at desc. Falls back to the hardcoded ESSAYS list (with null
 * published_at / deployed_at) when Supabase is not configured.
 *
 * Auth: X-Admin-Secret header.
 */
app.get("/api/admin/essays", requireAdminSecret, async (_req: Request, res: Response) => {
  if (!supabase) {
    // Fallback: return hardcoded essays as "published" placeholders
    const fallback = ESSAYS.map((e) => ({
      ...e,
      published_at: null,
      deployed_at: null,
      created_at: null,
      updated_at: null,
    }));
    return res.json({ essays: fallback });
  }

  const { data, error } = await supabase
    .from("essays")
    .select("slug, title, kicker, description, read_time, path, published_at, deployed_at, created_at, updated_at")
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[admin/essays] Supabase error:", error);
    return res.status(500).json({ error: "Failed to load essays" });
  }

  res.json({ essays: data ?? [] });
});

// ─── PATCH /api/admin/essays/:slug ───────────────────────────────────────────

/**
 * PATCH /api/admin/essays/:slug
 *
 * Update the published_at of an essay to schedule or publish it.
 *
 * Body:
 *   { published_at: string | null }
 *     - ISO 8601 datetime string  → schedule (future) or publish (past/now)
 *     - null                      → revert to draft
 *
 * Side effect: clears deployed_at so the cron will re-deploy the essay.
 *
 * Auth: X-Admin-Secret header.
 */
app.patch("/api/admin/essays/:slug", requireAdminSecret, async (req: Request, res: Response) => {
  const { slug } = req.params;
  const { published_at } = req.body as { published_at: string | null };

  if (!supabase) {
    return res.status(503).json({ error: "Supabase not configured" });
  }

  if (published_at !== null && published_at !== undefined) {
    const d = new Date(published_at as string);
    if (isNaN(d.getTime())) {
      return res.status(400).json({ error: "Invalid published_at value" });
    }
  }

  const { data, error } = await supabase
    .from("essays")
    .update({
      published_at: published_at ?? null,
      deployed_at: null, // clear so cron re-deploys when published_at arrives
    })
    .eq("slug", slug)
    .select("slug, title, published_at, deployed_at")
    .single();

  if (error) {
    console.error("[admin/essays] patch error:", error);
    return res.status(500).json({ error: "Failed to update essay" });
  }

  if (!data) {
    return res.status(404).json({ error: "Essay not found" });
  }

  res.json({ essay: data });
});

// ─── Email preference center ──────────────────────────────────────────────────

function requirePreferencesSecret(res: Response): boolean {
  if (!PREFERENCES_JWT_SECRET) {
    res.status(503).json({ error: "PREFERENCES_JWT_SECRET not configured" });
    return false;
  }
  return true;
}

// CORS pre-flight for preferences endpoints (called from the static site)
app.options("/api/email/preferences", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

app.options("/api/email/preferences/send-link", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

/**
 * GET /api/email/preferences?token={jwt}
 *
 * Decode the JWT to get subscriber_id, return current preferences.
 * If no row exists, returns the defaults (all true).
 */
app.get("/api/email/preferences", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!requirePreferencesSecret(res)) return;

  const { token } = req.query as { token?: string };
  if (!token) {
    res.status(400).json({ error: "token is required" });
    return;
  }

  const result = verifyPreferencesToken(token);
  if (!result.ok) {
    res.status(401).json({ error: "Invalid or expired token", expired: result.expired });
    return;
  }

  const email = result.email;
  const defaults = { weekly_digest: true, newsletter: true, course_updates: true };

  if (!supabase) {
    res.json({ email, preferences: defaults });
    return;
  }

  const { data, error } = await supabase
    .from("subscriber_preferences")
    .select("weekly_digest, newsletter, course_updates")
    .eq("subscriber_id", email)
    .maybeSingle();

  if (error) {
    console.error("[preferences] GET failed:", error);
    res.status(500).json({ error: "Failed to load preferences" });
    return;
  }

  res.json({ email, preferences: data ?? defaults });
});

/**
 * PATCH /api/email/preferences
 *
 * Body: { token, weekly_digest, newsletter, course_updates }
 * Upserts preferences for the subscriber identified by the JWT.
 */
app.patch("/api/email/preferences", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!requirePreferencesSecret(res)) return;

  const { token, weekly_digest, newsletter, course_updates } = req.body as {
    token?: string;
    weekly_digest?: boolean;
    newsletter?: boolean;
    course_updates?: boolean;
  };

  if (!token) {
    res.status(400).json({ error: "token is required" });
    return;
  }

  const result = verifyPreferencesToken(token);
  if (!result.ok) {
    res.status(401).json({ error: "Invalid or expired token", expired: result.expired });
    return;
  }

  const email = result.email;

  const updates: Record<string, boolean> = {};
  if (typeof weekly_digest === "boolean") updates.weekly_digest = weekly_digest;
  if (typeof newsletter === "boolean") updates.newsletter = newsletter;
  if (typeof course_updates === "boolean") updates.course_updates = course_updates;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No preference fields provided" });
    return;
  }

  if (!supabase) {
    console.warn("[preferences] PATCH skipped — Supabase not configured");
    res.json({ ok: true, email, preferences: updates });
    return;
  }

  const { error } = await supabase
    .from("subscriber_preferences")
    .upsert({ subscriber_id: email, ...updates }, { onConflict: "subscriber_id" });

  if (error) {
    console.error("[preferences] PATCH failed:", error);
    res.status(500).json({ error: "Failed to save preferences" });
    return;
  }

  console.log(`[preferences] Updated for ${email}:`, updates);
  res.json({ ok: true, email, preferences: updates });
});

/**
 * POST /api/email/preferences/send-link
 *
 * Body: { email }
 * Sends a fresh preferences-link email so the subscriber can manage their prefs
 * after their token has expired.
 */
app.post("/api/email/preferences/send-link", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!requirePreferencesSecret(res)) return;

  const { email } = req.body as { email?: string };
  if (!email || !email.includes("@")) {
    res.status(400).json({ error: "Valid email is required" });
    return;
  }

  const resend = new Resend(RESEND_API_KEY!);
  const token = signPreferencesToken(email.toLowerCase().trim());
  const prefUrl = `${SERVER_URL}/email/preferences/?token=${token}`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Manage your email preferences</title>
</head>
<body style="margin:0;padding:0;background:#faf8f4;font-family:Georgia,'Times New Roman',serif;">
  <div style="max-width:560px;margin:0 auto;padding:48px 24px;color:#2c2c2c;font-size:18px;line-height:1.8;">
    <p style="margin:0 0 24px;">Here is your preferences link:</p>
    <p style="margin:0 0 40px;">
      <a href="${prefUrl}"
         style="display:inline-block;background:#2c2c2c;color:#faf8f4;text-decoration:none;padding:12px 28px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:500;border-radius:4px;">
        Manage email preferences
      </a>
    </p>
    <p style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;color:#999;line-height:1.5;">
      This link expires in 30 days.
    </p>
  </div>
</body>
</html>`;

  const { error } = await resend.emails.send({
    from: EMAIL_FROM!,
    to: email.toLowerCase().trim(),
    replyTo: EMAIL_REPLY_TO || undefined,
    subject: "Your email preferences link",
    html,
  });

  if (error) {
    console.error("[preferences/send-link] Failed to send:", error);
    res.status(500).json({ error: "Failed to send preferences link" });
    return;
  }

  console.log(`[preferences/send-link] Sent to ${email}`);
  res.json({ ok: true });
});

// ─── POST /api/webhooks/resend ────────────────────────────────────────────────

/**
 * POST /api/webhooks/resend
 *
 * Receives Resend email webhook events and persists them to the email_events table.
 * Handles: email.opened, email.clicked, email.bounced, email.complained.
 *
 * Validates the svix-signature header when RESEND_WEBHOOK_SECRET is configured.
 * Returns 401 for unsigned requests if the secret is set.
 *
 * No auth key required — this endpoint is called by Resend's infrastructure.
 */
const TRACKED_EVENT_TYPES = new Set(["email.opened", "email.clicked", "email.bounced", "email.complained"]);

app.post("/api/webhooks/resend", async (req: Request, res: Response) => {
  const rawBody: string = (req as any).rawBody ?? JSON.stringify(req.body);

  if (!verifyResendWebhookSignature(rawBody, req.headers as Record<string, string | string[] | undefined>)) {
    console.warn("[webhook/resend] Rejected — invalid svix signature");
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }

  const payload = req.body as Record<string, unknown>;
  const eventType = String(payload.type ?? "");
  const data = (payload.data as Record<string, unknown>) ?? {};

  if (!TRACKED_EVENT_TYPES.has(eventType)) {
    res.json({ received: true, ignored: true });
    return;
  }

  const emailId = String(data.email_id ?? "") || null;
  const toField = data.to;
  const recipientEmail = Array.isArray(toField) ? String(toField[0]) : (toField ? String(toField) : null);
  const occurredAt = String(data.created_at ?? payload.created_at ?? new Date().toISOString());

  if (!supabase) {
    console.warn("[webhook/resend] Supabase not configured — event not stored");
    res.json({ received: true });
    return;
  }

  // Attempt to link this event to a newsletter_sends record
  let sendId: string | null = null;

  if (emailId) {
    // Test sends: newsletter_sends.email_id matches Resend's email_id
    const { data: bySingle } = await supabase
      .from("newsletter_sends")
      .select("id")
      .eq("email_id", emailId)
      .limit(1);
    if (bySingle && bySingle.length > 0) sendId = bySingle[0].id;
  }

  if (!sendId) {
    // Broadcast sends: look for broadcast_id in Resend tags
    const tags = (data.tags as Record<string, string>) ?? {};
    const broadcastId = tags.broadcast_id ?? null;
    if (broadcastId) {
      const { data: byBroadcast } = await supabase
        .from("newsletter_sends")
        .select("id")
        .eq("broadcast_id", broadcastId)
        .limit(1);
      if (byBroadcast && byBroadcast.length > 0) sendId = byBroadcast[0].id;
    }
  }

  const { error } = await supabase.from("email_events").insert({
    send_id: sendId,
    email_id: emailId,
    type: eventType,
    recipient_email: recipientEmail,
    metadata: data,
    created_at: occurredAt,
  });

  if (error) {
    console.error("[webhook/resend] Failed to store event:", error);
    res.status(500).json({ error: "Failed to store event" });
    return;
  }

  console.log(`[webhook/resend] ${eventType} stored — send=${sendId ?? "unlinked"}`);
  res.json({ received: true });
});

// ─── GET /api/newsletter/analytics ───────────────────────────────────────────

/**
 * GET /api/newsletter/analytics?sendId=<id>
 *
 * Returns open/click/bounce/complaint counts and rates for a specific newsletter send.
 * Auth: X-Admin-Secret header.
 */
app.get("/api/newsletter/analytics", requireAdminSecret, async (req: Request, res: Response) => {
  const { sendId } = req.query as { sendId?: string };

  if (!sendId) {
    res.status(400).json({ error: "sendId query param is required" });
    return;
  }

  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }

  const { data: send, error: sendError } = await supabase
    .from("newsletter_sends")
    .select("id, recipient_count, test_mode")
    .eq("id", sendId)
    .single();

  if (sendError || !send) {
    res.status(404).json({ error: "Send not found" });
    return;
  }

  const { data: events, error: eventsError } = await supabase
    .from("email_events")
    .select("type")
    .eq("send_id", sendId);

  if (eventsError) {
    res.status(500).json({ error: "Failed to fetch events", detail: eventsError });
    return;
  }

  const counts: Record<string, number> = {};
  for (const ev of events ?? []) {
    counts[ev.type] = (counts[ev.type] ?? 0) + 1;
  }

  const sent = send.recipient_count ?? 0;
  const opened = counts["email.opened"] ?? 0;
  const clicked = counts["email.clicked"] ?? 0;
  const bounced = counts["email.bounced"] ?? 0;
  const complained = counts["email.complained"] ?? 0;

  res.json({
    sendId,
    sent,
    opened,
    openRate: sent > 0 ? parseFloat(((opened / sent) * 100).toFixed(1)) : null,
    clicked,
    clickRate: sent > 0 ? parseFloat(((clicked / sent) * 100).toFixed(1)) : null,
    bounced,
    complained,
  });
});

// ─── GET /api/newsletter/analytics/summary ────────────────────────────────────

/**
 * GET /api/newsletter/analytics/summary
 *
 * Returns aggregate open/click rates across all live sends.
 * Auth: X-Admin-Secret header.
 */
app.get("/api/newsletter/analytics/summary", requireAdminSecret, async (_req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }

  const { data: sends, error: sendsError } = await supabase
    .from("newsletter_sends")
    .select("id, recipient_count")
    .eq("test_mode", false)
    .eq("status", "sent");

  if (sendsError) {
    res.status(500).json({ error: "Failed to fetch send data", detail: sendsError });
    return;
  }

  const liveIds = (sends ?? []).map((s) => s.id);
  const totalSent = (sends ?? []).reduce((sum, s) => sum + (s.recipient_count ?? 0), 0);

  if (liveIds.length === 0) {
    res.json({ totalSends: 0, totalSent: 0, avgOpenRate: null, avgClickRate: null, totalOpened: 0, totalClicked: 0, totalBounced: 0, totalComplained: 0 });
    return;
  }

  const { data: events, error: eventsError } = await supabase
    .from("email_events")
    .select("type")
    .in("send_id", liveIds);

  if (eventsError) {
    res.status(500).json({ error: "Failed to fetch events", detail: eventsError });
    return;
  }

  const counts: Record<string, number> = {};
  for (const ev of events ?? []) {
    counts[ev.type] = (counts[ev.type] ?? 0) + 1;
  }

  const totalOpened = counts["email.opened"] ?? 0;
  const totalClicked = counts["email.clicked"] ?? 0;
  const totalBounced = counts["email.bounced"] ?? 0;
  const totalComplained = counts["email.complained"] ?? 0;

  res.json({
    totalSends: liveIds.length,
    totalSent,
    totalOpened,
    totalClicked,
    totalBounced,
    totalComplained,
    avgOpenRate: totalSent > 0 ? parseFloat(((totalOpened / totalSent) * 100).toFixed(1)) : null,
    avgClickRate: totalSent > 0 ? parseFloat(((totalClicked / totalSent) * 100).toFixed(1)) : null,
  });
});

// ─── Convergence MVP proxy routes ─────────────────────────────────────────────
//
// These endpoints proxy data from the Convergence MVP for the admin overview
// page. They are auth-gated by X-Admin-Secret (same as all admin routes).
// Requires env vars: CONVERGENCE_MVP_URL, CONVERGENCE_ADMIN_WALLET
//
// GET /api/convergence/health     → /api/health        (public on MVP)
// GET /api/convergence/community  → /api/community/metrics?period=7d (public)
// GET /api/convergence/pass-count → /api/community/pass-count (public)
// GET /api/convergence/qa-stats   → /api/admin/qa-analytics (admin-wallet auth)

async function proxyConvergence(
  mvpPath: string,
  extraHeaders: Record<string, string> = {}
): Promise<{ ok: boolean; data: unknown }> {
  if (!CONVERGENCE_MVP_URL) return { ok: false, data: { error: "CONVERGENCE_MVP_URL not configured" } };
  const url = `${CONVERGENCE_MVP_URL}${mvpPath}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...extraHeaders },
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

app.get("/api/convergence/health", requireAdminSecret, async (_req: Request, res: Response) => {
  const { ok, data } = await proxyConvergence("/api/health");
  res.status(ok ? 200 : 502).json(data);
});

app.get("/api/convergence/community", requireAdminSecret, async (_req: Request, res: Response) => {
  const { ok, data } = await proxyConvergence("/api/community/metrics?period=7d");
  res.status(ok ? 200 : 502).json(data);
});

app.get("/api/convergence/pass-count", requireAdminSecret, async (_req: Request, res: Response) => {
  const { ok, data } = await proxyConvergence("/api/community/pass-count");
  res.status(ok ? 200 : 502).json(data);
});

app.get("/api/convergence/qa-stats", requireAdminSecret, async (_req: Request, res: Response) => {
  if (!CONVERGENCE_ADMIN_WALLET) {
    res.status(503).json({ error: "CONVERGENCE_ADMIN_WALLET not configured" });
    return;
  }
  const { ok, data } = await proxyConvergence("/api/admin/qa-analytics", {
    Authorization: `Bearer ${CONVERGENCE_ADMIN_WALLET}`,
  });
  res.status(ok ? 200 : 502).json(data);
});

// ─── Courses API ──────────────────────────────────────────────────────────────
//
// GET  /api/courses                — public; returns courses with is_unlocked
//                                   per user when Authorization header present
// POST /api/courses/:slug/complete — marks a course complete for the authed user
// GET  /api/admin/courses          — admin; full course list
// PATCH /api/admin/courses/:id     — admin; update course prerequisites

/**
 * Verify a Supabase JWT and return the user_id, or null if invalid.
 * Uses the Supabase service client to call auth.getUser() which validates
 * the token against the project's JWK set.
 */
async function getUserIdFromJwt(authHeader: string | undefined): Promise<string | null> {
  if (!supabase || !authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data.user) return null;
    return data.user.id;
  } catch {
    return null;
  }
}

// GET /api/courses
// Returns course list. If the caller sends a valid Supabase JWT in
// Authorization: Bearer <token>, each course includes is_unlocked computed
// from the caller's course_completions. Without auth, is_unlocked = is_free
// (free courses open, everything else locked).
app.get("/api/courses", async (req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }
  const { data: courses, error } = await supabase
    .from("courses")
    .select("id, slug, title, description, sessions_total, is_free, prerequisites, sort_order")
    .order("sort_order", { ascending: true });

  if (error) {
    res.status(500).json({ error: "Failed to fetch courses" });
    return;
  }

  const userId = await getUserIdFromJwt(req.headers.authorization);

  // Build completed course ID set for this user
  let completedCourseIds = new Set<string>();
  if (userId) {
    const { data: completions } = await supabase
      .from("course_completions")
      .select("course_id")
      .eq("user_id", userId);
    if (completions) {
      for (const c of completions) completedCourseIds.add(c.course_id);
    }
  }

  // Fetch review aggregates (avg_rating, review_count) for all courses
  const courseIds = (courses ?? []).map((c) => c.id);
  const reviewStatsByCourseId: Record<string, { avg_rating: number; review_count: number }> = {};
  if (courseIds.length > 0) {
    const { data: reviewRows } = await supabase
      .from("course_reviews")
      .select("course_id, rating")
      .in("course_id", courseIds);
    if (reviewRows) {
      const sums: Record<string, { total: number; count: number }> = {};
      for (const r of reviewRows) {
        if (!sums[r.course_id]) sums[r.course_id] = { total: 0, count: 0 };
        sums[r.course_id].total += r.rating;
        sums[r.course_id].count += 1;
      }
      for (const [cid, s] of Object.entries(sums)) {
        reviewStatsByCourseId[cid] = {
          avg_rating: Math.round((s.total / s.count) * 10) / 10,
          review_count: s.count,
        };
      }
    }
  }

  // Compute is_unlocked per course
  const result = (courses ?? []).map((course) => {
    const prereqs: string[] = Array.isArray(course.prerequisites) ? course.prerequisites : [];
    let is_unlocked: boolean;
    if (course.is_free || prereqs.length === 0) {
      is_unlocked = true;
    } else if (userId) {
      is_unlocked = prereqs.every((pid: string) => completedCourseIds.has(pid));
    } else {
      // Unauthenticated: locked unless free
      is_unlocked = false;
    }
    const stats = reviewStatsByCourseId[course.id] ?? { avg_rating: null, review_count: 0 };
    return { ...course, is_unlocked, avg_rating: stats.avg_rating, review_count: stats.review_count };
  });

  res.json({ courses: result });
});

// POST /api/courses/:slug/complete
// Marks a course as complete for the authenticated user (idempotent).
// Requires Authorization: Bearer <supabase-jwt>.
app.post("/api/courses/:slug/complete", async (req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }
  const userId = await getUserIdFromJwt(req.headers.authorization);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const { slug } = req.params;
  const { data: course, error: courseErr } = await supabase
    .from("courses")
    .select("id")
    .eq("slug", slug)
    .single();
  if (courseErr || !course) {
    res.status(404).json({ error: "Course not found" });
    return;
  }
  const { error } = await supabase
    .from("course_completions")
    .upsert({ user_id: userId, course_id: course.id }, { onConflict: "user_id,course_id" });
  if (error) {
    res.status(500).json({ error: "Failed to record completion" });
    return;
  }
  res.json({ status: "completed", courseId: course.id });
});

// GET /api/admin/courses
// Returns full course list for the admin UI (same data, no auth filter).
app.get("/api/admin/courses", requireAdminSecret, async (_req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }
  const { data, error } = await supabase
    .from("courses")
    .select("*")
    .order("sort_order", { ascending: true });
  if (error) {
    res.status(500).json({ error: "Failed to fetch courses" });
    return;
  }
  res.json({ courses: data ?? [] });
});

// PATCH /api/admin/courses/:id
// Updates mutable course fields. Only prerequisites, sort_order, is_free, and
// description are patchable to prevent accidental slug/title stomps.
app.patch("/api/admin/courses/:id", requireAdminSecret, async (req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }
  const { id } = req.params;
  const { prerequisites, sort_order, is_free, description } = req.body as {
    prerequisites?: string[];
    sort_order?: number;
    is_free?: boolean;
    description?: string;
  };

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (Array.isArray(prerequisites)) patch.prerequisites = prerequisites;
  if (typeof sort_order === "number") patch.sort_order = sort_order;
  if (typeof is_free === "boolean") patch.is_free = is_free;
  if (typeof description === "string") patch.description = description;

  const { data, error } = await supabase
    .from("courses")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error || !data) {
    res.status(error ? 500 : 404).json({ error: error?.message ?? "Course not found" });
    return;
  }
  res.json({ course: data });
});

// ─── Course Reviews API ───────────────────────────────────────────────────────
//
// POST /api/courses/:slug/reviews — upsert rating + optional text for authed user
// GET  /api/courses/:slug/reviews — paginated public list with wallet/display_name

// POST /api/courses/:slug/reviews
// Upserts a rating (1–5) and optional review_text (≤500 chars) for the authed user.
// Idempotent: re-submitting updates the existing row.
app.post("/api/courses/:slug/reviews", async (req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }
  const userId = await getUserIdFromJwt(req.headers.authorization);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const { slug } = req.params;
  const { rating, review_text } = req.body as { rating?: unknown; review_text?: unknown };

  if (typeof rating !== "number" || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    res.status(400).json({ error: "rating must be an integer between 1 and 5" });
    return;
  }
  if (review_text !== undefined && review_text !== null && typeof review_text !== "string") {
    res.status(400).json({ error: "review_text must be a string" });
    return;
  }
  const text = typeof review_text === "string" ? review_text.trim() : null;
  if (text && text.length > 500) {
    res.status(400).json({ error: "review_text must be 500 characters or fewer" });
    return;
  }

  const { data: course, error: courseErr } = await supabase
    .from("courses")
    .select("id")
    .eq("slug", slug)
    .single();
  if (courseErr || !course) {
    res.status(404).json({ error: "Course not found" });
    return;
  }

  const { error } = await supabase
    .from("course_reviews")
    .upsert(
      { user_id: userId, course_id: course.id, rating, review_text: text || null },
      { onConflict: "user_id,course_id" }
    );
  if (error) {
    res.status(500).json({ error: "Failed to save review" });
    return;
  }
  res.json({ status: "ok" });
});

// GET /api/courses/:slug/reviews
// Returns paginated reviews (public). Each review includes rating, truncated
// review_text (≤200 chars), wallet address, display_name, and created_at.
app.get("/api/courses/:slug/reviews", async (req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }
  const { slug } = req.params;
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const perPage = Math.min(20, Math.max(1, parseInt(String(req.query.per_page ?? "5"), 10) || 5));

  const { data: course, error: courseErr } = await supabase
    .from("courses")
    .select("id")
    .eq("slug", slug)
    .single();
  if (courseErr || !course) {
    res.status(404).json({ error: "Course not found" });
    return;
  }

  const from = (page - 1) * perPage;
  const to = from + perPage - 1;

  const { data: reviews, error, count } = await supabase
    .from("course_reviews")
    .select("rating, review_text, created_at, user_id", { count: "exact" })
    .eq("course_id", course.id)
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) {
    res.status(500).json({ error: "Failed to fetch reviews" });
    return;
  }

  // Enrich with user profile (wallet/display_name) — best-effort
  const userIds = (reviews ?? []).map((r) => r.user_id).filter(Boolean);
  const profilesByUserId: Record<string, { wallet_address: string; display_name: string | null }> = {};
  if (userIds.length > 0) {
    const { data: profiles } = await supabase
      .from("user_profiles")
      .select("id, wallet_address, display_name")
      .in("id", userIds);
    if (profiles) {
      for (const p of profiles) profilesByUserId[p.id] = p;
    }
  }

  const result = (reviews ?? []).map((r) => {
    const profile = profilesByUserId[r.user_id];
    const rawText: string | null = r.review_text ?? null;
    return {
      rating: r.rating,
      review_text: rawText && rawText.length > 200 ? rawText.slice(0, 200) + "\u2026" : rawText,
      wallet: profile?.wallet_address ?? null,
      display_name: profile?.display_name ?? null,
      created_at: r.created_at,
    };
  });

  res.json({ reviews: result, total: count ?? 0, page, per_page: perPage });
});

// ─── Session Notes API ────────────────────────────────────────────────────────
//
// GET  /api/sessions/notes       — returns session_ids with non-empty notes for the authed user
// GET  /api/sessions/:id/notes   — returns {content} for the authed user
// PUT  /api/sessions/:id/notes   — upserts {content} for the authed user (max 2000 chars)
//
// All three endpoints require Authorization: Bearer <supabase-jwt>.
// session_id is a stable slug like "the-honest-meditator-1".

const MAX_NOTE_CHARS = 2000;

// GET /api/sessions/notes
// Returns the set of session_ids where the user has saved non-empty notes.
// Used by the course landing page to render pencil indicators.
// Must be registered before /:id routes to avoid ":id = notes" ambiguity.
app.get("/api/sessions/notes", async (req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }
  const userId = await getUserIdFromJwt(req.headers.authorization);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const { data, error } = await supabase
    .from("session_notes")
    .select("session_id")
    .eq("user_id", userId)
    .neq("content", "");
  if (error) {
    res.status(500).json({ error: "Failed to fetch notes index" });
    return;
  }
  res.json({ sessions: (data ?? []).map((r) => r.session_id) });
});

// GET /api/sessions/:id/notes
app.get("/api/sessions/:id/notes", async (req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }
  const userId = await getUserIdFromJwt(req.headers.authorization);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const { id } = req.params;
  const { data, error } = await supabase
    .from("session_notes")
    .select("content, updated_at")
    .eq("user_id", userId)
    .eq("session_id", id)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: "Failed to fetch note" });
    return;
  }
  res.json({ content: data?.content ?? "", updated_at: data?.updated_at ?? null });
});

// PUT /api/sessions/:id/notes
app.put("/api/sessions/:id/notes", async (req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }
  const userId = await getUserIdFromJwt(req.headers.authorization);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const { id } = req.params;
  const { content } = req.body as { content?: unknown };
  if (typeof content !== "string") {
    res.status(400).json({ error: "content must be a string" });
    return;
  }
  if (content.length > MAX_NOTE_CHARS) {
    res.status(400).json({ error: `Note exceeds ${MAX_NOTE_CHARS} character limit` });
    return;
  }
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("session_notes")
    .upsert(
      { user_id: userId, session_id: id, content, updated_at: now },
      { onConflict: "user_id,session_id" }
    );
  if (error) {
    res.status(500).json({ error: "Failed to save note" });
    return;
  }
  res.json({ status: "saved", updated_at: now });
});

// ─── Essay Reading Tracker API ────────────────────────────────────────────────
//
// POST /api/essays/:slug/read-progress  — record a completed essay read (anon ok)
// GET  /api/reading-streak/me           — return streak data for authed user

const VALID_ESSAY_SLUGS = new Set([
  "paradox-of-acceptance",
  "should-you-get-into-mindfulness",
  "the-avoidance-problem",
  "the-cherry-picking-problem",
  "when-to-quit",
]);

// CORS pre-flight for read-progress (called from static essay pages)
app.options("/api/essays/:slug/read-progress", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id");
  res.sendStatus(204);
});

app.options("/api/reading-streak/me", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.sendStatus(204);
});

/**
 * POST /api/essays/:slug/read-progress
 *
 * Records that a reader spent 30+ seconds on an essay.
 * Auth is optional — authenticated users update their reading streak;
 * anonymous users are tracked by session_id (from X-Session-Id header).
 *
 * Body (optional): { read_duration_seconds?: number }
 */
app.post("/api/essays/:slug/read-progress", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }

  const { slug } = req.params;
  if (!VALID_ESSAY_SLUGS.has(slug)) {
    res.status(404).json({ error: "Essay not found" });
    return;
  }

  const userId = await getUserIdFromJwt(req.headers.authorization);
  const sessionId = !userId ? (req.headers["x-session-id"] as string | undefined)?.slice(0, 64) : undefined;

  if (!userId && !sessionId) {
    res.status(400).json({ error: "x-session-id header required for unauthenticated requests" });
    return;
  }

  const readDuration = typeof req.body?.read_duration_seconds === "number"
    ? Math.min(Math.max(Math.round(req.body.read_duration_seconds), 30), 7200)
    : 30;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Insert the essay read (one row per reader per essay per calendar day).
  // Check-then-insert for both auth and anon — expression-based unique indexes
  // aren't reliably usable with Supabase's upsert onConflict parameter.
  let insertError: unknown = null;
  if (userId) {
    const { data: existing } = await supabase
      .from("essay_reads")
      .select("id")
      .eq("user_id", userId)
      .eq("essay_slug", slug)
      .gte("read_at", today + "T00:00:00Z")
      .limit(1);

    if (!existing || existing.length === 0) {
      const { error } = await supabase.from("essay_reads").insert({
        user_id: userId,
        essay_slug: slug,
        read_at: new Date().toISOString(),
        read_duration_seconds: readDuration,
      });
      insertError = error;
    }
  } else {
    // For anonymous, only insert if not already read today (don't upsert — no conflict key for anon+session)
    const { data: existing } = await supabase
      .from("essay_reads")
      .select("id")
      .eq("session_id", sessionId!)
      .eq("essay_slug", slug)
      .gte("read_at", today + "T00:00:00Z")
      .limit(1);

    if (!existing || existing.length === 0) {
      const { error } = await supabase.from("essay_reads").insert({
        session_id: sessionId,
        essay_slug: slug,
        read_at: new Date().toISOString(),
        read_duration_seconds: readDuration,
      });
      insertError = error;
    }
  }

  if (insertError) {
    console.error("[essay-read] insert error:", insertError);
    res.status(500).json({ error: "Failed to record read" });
    return;
  }

  // For authenticated users, update reading streak
  let streak: { current_streak: number; longest_streak: number; milestone: number | null } | null = null;
  if (userId) {
    streak = await upsertReadingStreak(userId, today);
  }

  res.json({ ok: true, ...(streak ? { streak } : {}) });
});

/**
 * Upsert the reading_streaks row for a user after a new essay read.
 * Streak logic (same as OLU-395 course streaks):
 *   - last_read_date = today → no change
 *   - last_read_date = yesterday → increment current_streak
 *   - last_read_date < yesterday → reset to 1
 *   - Update longest_streak if current > longest
 * Returns current_streak, longest_streak, and a milestone if newly crossed.
 */
async function upsertReadingStreak(
  userId: string,
  today: string
): Promise<{ current_streak: number; longest_streak: number; milestone: number | null }> {
  const { data: existing } = await supabase!
    .from("reading_streaks")
    .select("current_streak, longest_streak, last_read_date")
    .eq("user_id", userId)
    .maybeSingle();

  const prev = existing as { current_streak: number; longest_streak: number; last_read_date: string | null } | null;

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

  let currentStreak = 1;
  let longestStreak = prev?.longest_streak ?? 1;
  const prevStreak = prev?.current_streak ?? 0;

  if (prev?.last_read_date === today) {
    // Already read today — no change needed
    return { current_streak: prevStreak, longest_streak: longestStreak, milestone: null };
  } else if (prev?.last_read_date === yesterday) {
    currentStreak = prevStreak + 1;
  } else {
    currentStreak = 1;
  }

  if (currentStreak > longestStreak) longestStreak = currentStreak;

  await supabase!.from("reading_streaks").upsert(
    {
      user_id: userId,
      current_streak: currentStreak,
      longest_streak: longestStreak,
      last_read_date: today,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  // Check for milestone (7 or 30 days; only fires when crossing the threshold)
  const milestones = [7, 30];
  const milestone = milestones.find(
    (m) => currentStreak === m && prevStreak < m
  ) ?? null;

  return { current_streak: currentStreak, longest_streak: longestStreak, milestone };
}

/**
 * GET /api/reading-streak/me
 *
 * Returns reading streak and recent history for the authenticated user.
 * Requires Authorization: Bearer <supabase-jwt>.
 */
app.get("/api/reading-streak/me", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }

  const userId = await getUserIdFromJwt(req.headers.authorization);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  // Streak row
  const { data: streakRow } = await supabase
    .from("reading_streaks")
    .select("current_streak, longest_streak, last_read_date")
    .eq("user_id", userId)
    .maybeSingle();

  // Read history for heatmap — last 90 days, one row per day
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  const { data: reads } = await supabase
    .from("essay_reads")
    .select("essay_slug, read_at")
    .eq("user_id", userId)
    .gte("read_at", since)
    .order("read_at", { ascending: false });

  // Aggregate into dates read (Set of YYYY-MM-DD strings) and total count
  const datesRead = new Set<string>();
  let totalReads = 0;
  for (const row of (reads ?? []) as Array<{ essay_slug: string; read_at: string }>) {
    datesRead.add(row.read_at.slice(0, 10));
    totalReads++;
  }

  // Total reads ever (all time, not just 90d)
  const { count: totalEssays } = await supabase
    .from("essay_reads")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);

  res.json({
    current_streak: streakRow?.current_streak ?? 0,
    longest_streak: streakRow?.longest_streak ?? 0,
    last_read_date: streakRow?.last_read_date ?? null,
    total_reads_90d: totalReads,
    total_essays_read: (totalEssays as unknown as number) ?? 0,
    read_dates_90d: Array.from(datesRead).sort(),
  });
});

// ─── Course PDF Export ────────────────────────────────────────────────────────
//
// GET /api/courses/:slug/export?format=pdf
// Returns a formatted PDF of all course sessions.
// Auth required (enrolled users only). Caches result in Supabase Storage for 24h.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const COURSES_BASE_DIR = join(__dirname, "..", "courses");
const PDF_CACHE_BUCKET = "course-exports";
const PDF_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Brand colours (mirrored from design-tokens)
const PDF_CREAM = "#faf8f4";
const PDF_SAGE = "#7d8c6e";
const PDF_INK = "#2c2c2c";
const PDF_INK_LIGHT = "#555555";
const PDF_RULE = "#e2ddd6";
const PDF_EXERCISE_BG = "#f0ede6";

interface SessionContent {
  number: number;
  title: string;
  duration: string;
  blocks: Array<{ type: "paragraph" | "exercise" | "summary"; text?: string; exerciseTitle?: string; lines?: string[] }>;
}

function extractSessionContent(slug: string, n: number): SessionContent | null {
  const htmlPath = join(COURSES_BASE_DIR, slug, `session-${n}`, "index.html");
  if (!existsSync(htmlPath)) return null;

  const html = readFileSync(htmlPath, "utf-8");
  const $ = cheerio.load(html);

  const title = $("h1").first().text().trim();
  const duration = $(".duration").first().text().trim();

  const blocks: SessionContent["blocks"] = [];

  $("article").children().each((_i, el) => {
    const $el = $(el);
    const tag = (el as { name?: string }).name;

    if (tag === "p") {
      const cls = $el.attr("class") ?? "";
      if (cls.includes("closing") || cls.includes("summary-label")) return;
      const text = $el.text().trim();
      if (text) blocks.push({ type: "paragraph", text });
    } else if (tag === "div" && $el.hasClass("exercise")) {
      const exerciseTitle = $el.find(".exercise-title").text().trim();
      const lines: string[] = [];
      $el.find("p").each((_j, p) => {
        const cls2 = $(p).attr("class") ?? "";
        if (cls2.includes("exercise-title")) return;
        const text = $(p).text().trim();
        if (text) lines.push(text);
      });
      if (exerciseTitle || lines.length) {
        blocks.push({ type: "exercise", exerciseTitle, lines });
      }
    } else if (tag === "div" && $el.hasClass("session-summary")) {
      const summary = $el.find("p:not(.summary-label)").text().trim();
      if (summary) blocks.push({ type: "summary", text: summary });
    }
  });

  return { number: n, title, duration, blocks };
}

async function generateCoursePdf(
  slug: string,
  course: { title: string; description: string; sessions_total: number }
): Promise<Buffer> {
  const MARGIN = 72;
  const PAGE_W = 612; // US Letter
  const CONTENT_W = PAGE_W - MARGIN * 2;

  const doc = new PDFDocument({
    size: "LETTER",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    info: {
      Title: course.title,
      Author: "Paradox of Acceptance",
      Subject: course.description,
      Creator: "paradoxofacceptance.xyz",
    },
    autoFirstPage: false,
    bufferPages: true,
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));

  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // Draw cream background on every page
  doc.on("pageAdded", () => {
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(PDF_CREAM);
    doc.fillColor(PDF_INK);
  });

  // Helper: add a new page
  function addPage() {
    doc.addPage({ size: "LETTER" });
  }

  // ── Cover page ──────────────────────────────────────────────────────────────
  addPage();

  const genDate = new Date().toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });

  doc.y = MARGIN + 120;

  // Kicker
  doc.font("Helvetica").fontSize(10).fillColor(PDF_SAGE)
    .text("PARADOX OF ACCEPTANCE", MARGIN, doc.y, {
      width: CONTENT_W, align: "center", characterSpacing: 2,
    });

  doc.moveDown(1.5);

  // Title
  doc.font("Times-Roman").fontSize(38).fillColor(PDF_INK)
    .text(course.title, MARGIN, doc.y, { width: CONTENT_W, align: "center" });

  doc.moveDown(1.2);

  // Rule
  const ruleY = doc.y;
  doc.moveTo(MARGIN + CONTENT_W * 0.25, ruleY)
    .lineTo(MARGIN + CONTENT_W * 0.75, ruleY)
    .strokeColor(PDF_RULE).lineWidth(0.75).stroke();

  doc.moveDown(1.5);

  // Description
  doc.font("Times-Roman").fontSize(13).fillColor(PDF_INK_LIGHT)
    .text(course.description, MARGIN + CONTENT_W * 0.1, doc.y, {
      width: CONTENT_W * 0.8, align: "center", lineGap: 3,
    });

  doc.moveDown(2);

  // Date
  doc.font("Helvetica").fontSize(10).fillColor(PDF_INK_LIGHT)
    .text(`Generated ${genDate}`, MARGIN, doc.y, { width: CONTENT_W, align: "center" });

  // ── Table of Contents page ──────────────────────────────────────────────────
  addPage();

  doc.y = MARGIN + 32;

  doc.font("Helvetica").fontSize(10).fillColor(PDF_SAGE)
    .text("CONTENTS", MARGIN, doc.y, { characterSpacing: 2 });

  doc.moveDown(1.2);

  // Rule
  doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + CONTENT_W, doc.y)
    .strokeColor(PDF_RULE).lineWidth(0.5).stroke();

  doc.moveDown(1);

  for (let i = 1; i <= course.sessions_total; i++) {
    const session = extractSessionContent(slug, i);
    const sessionTitle = session?.title ?? `Session ${i}`;
    doc.font("Helvetica").fontSize(11).fillColor(PDF_INK_LIGHT)
      .text(`Session ${i}`, MARGIN, doc.y, { continued: true, width: 72 });
    doc.font("Times-Roman").fontSize(12).fillColor(PDF_INK)
      .text(`  ${sessionTitle}`, { continued: false });
    doc.moveDown(0.6);
  }

  // ── Session chapters ────────────────────────────────────────────────────────
  let pageNum = 2; // cover + toc = pages 1–2

  for (let i = 1; i <= course.sessions_total; i++) {
    const session = extractSessionContent(slug, i);
    if (!session) continue;
    pageNum++;

    addPage();
    doc.y = MARGIN + 24;

    // Chapter kicker
    doc.font("Helvetica").fontSize(9).fillColor(PDF_SAGE)
      .text(`SESSION ${i} OF ${course.sessions_total}`, MARGIN, doc.y, { characterSpacing: 1.5 });

    doc.moveDown(0.8);

    // Chapter title
    doc.font("Times-Bold").fontSize(26).fillColor(PDF_INK)
      .text(session.title, MARGIN, doc.y, { width: CONTENT_W, lineGap: 2 });

    if (session.duration) {
      doc.moveDown(0.5);
      doc.font("Helvetica").fontSize(10).fillColor(PDF_INK_LIGHT)
        .text(session.duration, MARGIN, doc.y);
    }

    doc.moveDown(0.8);

    // Rule
    doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + CONTENT_W, doc.y)
      .strokeColor(PDF_RULE).lineWidth(0.5).stroke();

    doc.moveDown(1);

    // Content blocks
    for (const block of session.blocks) {
      if (block.type === "paragraph") {
        doc.font("Times-Roman").fontSize(11.5).fillColor(PDF_INK)
          .text(block.text ?? "", MARGIN, doc.y, { width: CONTENT_W, lineGap: 2.5, paragraphGap: 0 });
        doc.moveDown(0.55);
      } else if (block.type === "exercise") {
        doc.moveDown(0.4);

        // Sage left border indicator
        const exY = doc.y;
        doc.rect(MARGIN, exY, 3, 10).fill(PDF_SAGE);
        doc.fillColor(PDF_INK);

        // Exercise title
        doc.font("Helvetica-Bold").fontSize(10).fillColor(PDF_SAGE)
          .text(block.exerciseTitle ?? "Practice", MARGIN + 12, exY, { width: CONTENT_W - 12 });

        doc.moveDown(0.4);

        // Exercise lines
        for (const line of block.lines ?? []) {
          doc.font("Times-Italic").fontSize(11).fillColor(PDF_INK_LIGHT)
            .text(line, MARGIN + 12, doc.y, { width: CONTENT_W - 12, lineGap: 2 });
          doc.moveDown(0.35);
        }

        // Extend border down to cover full exercise
        const exHeight = doc.y - exY;
        doc.rect(MARGIN, exY, 2, exHeight).fill(PDF_SAGE);
        doc.fillColor(PDF_INK);

        doc.moveDown(0.4);
      } else if (block.type === "summary") {
        doc.moveDown(0.6);

        // Summary label
        doc.font("Helvetica").fontSize(9).fillColor(PDF_SAGE)
          .text("SESSION SUMMARY", MARGIN, doc.y, { characterSpacing: 1 });

        doc.moveDown(0.4);

        // Rule
        doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + CONTENT_W * 0.5, doc.y)
          .strokeColor(PDF_RULE).lineWidth(0.5).stroke();

        doc.moveDown(0.5);

        doc.font("Times-Italic").fontSize(11).fillColor(PDF_INK_LIGHT)
          .text(block.text ?? "", MARGIN, doc.y, { width: CONTENT_W, lineGap: 2.5 });

        doc.moveDown(0.5);
      }
    }
  }

  // Add page numbers to all pages (skip cover and TOC)
  const pageRange = doc.bufferedPageRange();
  for (let p = 0; p < pageRange.count; p++) {
    doc.switchToPage(p);
    if (p >= 2) {
      // Session pages only
      const pageNumText = String(p - 1); // session pages start at 1
      doc.font("Helvetica").fontSize(9).fillColor(PDF_INK_LIGHT)
        .text(pageNumText, MARGIN, doc.page.height - MARGIN + 20, {
          width: CONTENT_W, align: "center",
        });
    }
  }

  doc.end();
  return result;
}

// Check Supabase Storage for a cached PDF (< 24h old)
async function getCachedPdf(slug: string): Promise<Buffer | null> {
  if (!supabase) return null;
  try {
    const filePath = `${slug}/export.pdf`;
    const { data: files } = await supabase.storage
      .from(PDF_CACHE_BUCKET)
      .list(slug, { search: "export.pdf" });

    if (!files || files.length === 0) return null;
    const file = files[0];
    const fileAge = Date.now() - new Date(file.updated_at ?? 0).getTime();
    if (fileAge > PDF_CACHE_TTL_MS) return null;

    const { data, error } = await supabase.storage.from(PDF_CACHE_BUCKET).download(filePath);
    if (error || !data) return null;

    return Buffer.from(await data.arrayBuffer());
  } catch {
    return null;
  }
}

// Upload generated PDF to Supabase Storage (non-fatal if it fails)
async function cachePdf(slug: string, buf: Buffer): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.storage.from(PDF_CACHE_BUCKET).upload(`${slug}/export.pdf`, buf, {
      contentType: "application/pdf",
      upsert: true,
    });
  } catch {
    // Non-fatal — serve the PDF even if caching fails
  }
}

// GET /api/courses/:slug/export?format=pdf
app.get("/api/courses/:slug/export", async (req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }

  const format = req.query.format as string | undefined;
  if (format !== "pdf") {
    res.status(400).json({ error: "Unsupported format. Use ?format=pdf" });
    return;
  }

  // Auth required
  const userId = await getUserIdFromJwt(req.headers.authorization);
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const slug = String(req.params.slug);

  // Fetch course metadata
  const { data: course, error: courseErr } = await supabase
    .from("courses")
    .select("id, title, description, sessions_total, is_free, prerequisites")
    .eq("slug", slug)
    .single();

  if (courseErr || !course) {
    res.status(404).json({ error: "Course not found" });
    return;
  }

  // Enrollment check: for non-free courses, verify prerequisites are completed
  if (!course.is_free) {
    const prereqs: string[] = Array.isArray(course.prerequisites) ? course.prerequisites : [];
    if (prereqs.length > 0) {
      const { data: completions } = await supabase
        .from("course_completions")
        .select("course_id")
        .eq("user_id", userId)
        .in("course_id", prereqs);

      const done = new Set((completions ?? []).map((c: { course_id: string }) => c.course_id));
      if (!prereqs.every((pid) => done.has(pid))) {
        res.status(403).json({ error: "Complete prerequisites to access this course export" });
        return;
      }
    }
  }

  // Serve cached PDF if available
  const cached = await getCachedPdf(slug);
  if (cached) {
    const fileName = `${slug}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("X-Cache", "HIT");
    res.send(cached);
    return;
  }

  // Generate PDF
  try {
    const pdfBuf = await generateCoursePdf(slug, course);
    cachePdf(slug, pdfBuf).catch(() => {}); // async, non-blocking

    const fileName = `${slug}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("X-Cache", "MISS");
    res.send(pdfBuf);
  } catch (err) {
    console.error("PDF generation error:", err);
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});

// ─── Reading Lists API ────────────────────────────────────────────────────────
//
// GET  /api/reading-lists        — public; returns published lists + item count + first-3 essays
// GET  /api/reading-lists/:slug  — public; full list with ordered essays + annotations
// POST /api/admin/reading-lists  — admin; create a reading list (with optional items)
// PATCH /api/admin/reading-lists/:slug — admin; update list fields and/or reorder items

// CORS pre-flight for public reading-list endpoints (called from static pages)
app.options("/api/reading-lists", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

app.options("/api/reading-lists/:slug", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

// Known essays — used to enrich reading list responses with title/path metadata.
// Matches the ESSAYS constant already defined above.
const ESSAY_META: Record<string, { title: string; description: string; path: string }> = {
  "paradox-of-acceptance": {
    title: "The Paradox of Acceptance",
    description: "A meditation on what happens to ambition, urgency, and deferred gratification when mindfulness becomes very good.",
    path: "/mindfulness-essays/paradox-of-acceptance/",
  },
  "should-you-get-into-mindfulness": {
    title: "Should You Get Into Mindfulness?",
    description: "An honest look at who benefits from mindfulness practice and who might be better served elsewhere.",
    path: "/mindfulness-essays/should-you-get-into-mindfulness/",
  },
  "the-avoidance-problem": {
    title: "The Avoidance Problem",
    description: "On using mindfulness to avoid rather than engage — and how to tell the difference.",
    path: "/mindfulness-essays/the-avoidance-problem/",
  },
  "the-cherry-picking-problem": {
    title: "The Cherry-Picking Problem",
    description: "Why we select the comfortable parts of mindfulness and leave the harder teachings untouched.",
    path: "/mindfulness-essays/the-cherry-picking-problem/",
  },
  "when-to-quit": {
    title: "When to Quit",
    description: "How mindfulness changes the calculus around persistence, quitting, and what counts as giving up.",
    path: "/mindfulness-essays/when-to-quit/",
  },
};

/**
 * GET /api/reading-lists
 *
 * Returns all published reading lists with:
 *   - item_count (number of essays)
 *   - estimated_read_minutes (item_count * 7)
 *   - preview_essays — first 3 essays with title + path
 */
app.get("/api/reading-lists", async (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }

  const { data: lists, error: listsErr } = await supabase
    .from("reading_lists")
    .select("id, slug, title, description, cover_image_url, display_order")
    .eq("published", true)
    .order("display_order", { ascending: true });

  if (listsErr) {
    console.error("[reading-lists] Supabase error:", listsErr);
    res.status(500).json({ error: "Failed to load reading lists" });
    return;
  }

  if (!lists || lists.length === 0) {
    res.json({ reading_lists: [] });
    return;
  }

  const listIds = lists.map((l) => l.id);
  const { data: items, error: itemsErr } = await supabase
    .from("reading_list_items")
    .select("list_id, essay_slug, position")
    .in("list_id", listIds)
    .order("position", { ascending: true });

  if (itemsErr) {
    console.error("[reading-lists] items error:", itemsErr);
    res.status(500).json({ error: "Failed to load list items" });
    return;
  }

  // Group items by list_id
  const itemsByList: Record<string, string[]> = {};
  for (const item of items ?? []) {
    if (!itemsByList[item.list_id]) itemsByList[item.list_id] = [];
    itemsByList[item.list_id].push(item.essay_slug);
  }

  const reading_lists = lists.map((list) => {
    const slugs = itemsByList[list.id] ?? [];
    const preview_essays = slugs.slice(0, 3).map((slug) => ({
      slug,
      title: ESSAY_META[slug]?.title ?? slug,
      path: ESSAY_META[slug]?.path ?? `/mindfulness-essays/${slug}/`,
    }));

    // Fallback cover image: first essay's OG image path (conventional)
    const cover_image_url = list.cover_image_url
      || (slugs[0] ? `/mindfulness-essays/${slugs[0]}/og-image.jpg` : null);

    return {
      slug: list.slug,
      title: list.title,
      description: list.description,
      cover_image_url,
      display_order: list.display_order,
      item_count: slugs.length,
      estimated_read_minutes: slugs.length * 7,
      preview_essays,
    };
  });

  res.json({ reading_lists });
});

/**
 * GET /api/reading-lists/:slug
 *
 * Returns a single published reading list with all essays in order.
 * Each essay item includes: essay_slug, title, description, path, annotation, position.
 */
app.get("/api/reading-lists/:slug", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }

  const { slug } = req.params;

  const { data: list, error: listErr } = await supabase
    .from("reading_lists")
    .select("id, slug, title, description, cover_image_url, display_order, created_at")
    .eq("slug", slug)
    .eq("published", true)
    .single();

  if (listErr || !list) {
    res.status(404).json({ error: "Reading list not found" });
    return;
  }

  const { data: items, error: itemsErr } = await supabase
    .from("reading_list_items")
    .select("essay_slug, position, annotation")
    .eq("list_id", list.id)
    .order("position", { ascending: true });

  if (itemsErr) {
    console.error("[reading-lists/:slug] items error:", itemsErr);
    res.status(500).json({ error: "Failed to load list items" });
    return;
  }

  const essays = (items ?? []).map((item) => ({
    slug: item.essay_slug,
    title: ESSAY_META[item.essay_slug]?.title ?? item.essay_slug,
    description: ESSAY_META[item.essay_slug]?.description ?? null,
    path: ESSAY_META[item.essay_slug]?.path ?? `/mindfulness-essays/${item.essay_slug}/`,
    annotation: item.annotation ?? null,
    position: item.position,
  }));

  res.json({
    reading_list: {
      slug: list.slug,
      title: list.title,
      description: list.description,
      cover_image_url: list.cover_image_url,
      item_count: essays.length,
      estimated_read_minutes: essays.length * 7,
      essays,
    },
  });
});

/**
 * POST /api/admin/reading-lists
 *
 * Create a new reading list.
 * Body: { slug, title, description?, cover_image_url?, display_order?, published?, items? }
 *   items: [{ essay_slug, position, annotation? }]
 * Auth: X-Admin-Secret header.
 */
app.post("/api/admin/reading-lists", requireAdminSecret, async (req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }

  const { slug, title, description, cover_image_url, display_order, published, items } = req.body as {
    slug?: string;
    title?: string;
    description?: string;
    cover_image_url?: string;
    display_order?: number;
    published?: boolean;
    items?: Array<{ essay_slug: string; position: number; annotation?: string }>;
  };

  if (!slug || !title) {
    res.status(400).json({ error: "slug and title are required" });
    return;
  }

  const { data: list, error: insertErr } = await supabase
    .from("reading_lists")
    .insert({
      slug,
      title,
      description: description ?? null,
      cover_image_url: cover_image_url ?? null,
      display_order: display_order ?? 0,
      published: published ?? false,
    })
    .select("id, slug, title")
    .single();

  if (insertErr) {
    console.error("[admin/reading-lists POST] insert error:", insertErr);
    if (insertErr.code === "23505") {
      res.status(409).json({ error: "A reading list with this slug already exists" });
    } else {
      res.status(500).json({ error: "Failed to create reading list" });
    }
    return;
  }

  // Insert items if provided
  if (items && items.length > 0) {
    const rows = items.map((item) => ({
      list_id: list.id,
      essay_slug: item.essay_slug,
      position: item.position,
      annotation: item.annotation ?? null,
    }));
    const { error: itemsErr } = await supabase.from("reading_list_items").insert(rows);
    if (itemsErr) {
      console.error("[admin/reading-lists POST] items insert error:", itemsErr);
      // List was created — don't fail the whole request; report partial success
      res.status(201).json({ reading_list: list, warning: "List created but some items failed to insert" });
      return;
    }
  }

  res.status(201).json({ reading_list: list });
});

/**
 * PATCH /api/admin/reading-lists/:slug
 *
 * Update a reading list's fields and/or replace its items (for reordering).
 * Body: { title?, description?, cover_image_url?, display_order?, published?, items? }
 *   Providing `items` replaces all current items for this list.
 * Auth: X-Admin-Secret header.
 */
app.patch("/api/admin/reading-lists/:slug", requireAdminSecret, async (req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }

  const { slug } = req.params;

  // Fetch the list
  const { data: list, error: fetchErr } = await supabase
    .from("reading_lists")
    .select("id")
    .eq("slug", slug)
    .single();

  if (fetchErr || !list) {
    res.status(404).json({ error: "Reading list not found" });
    return;
  }

  const { title, description, cover_image_url, display_order, published, items } = req.body as {
    title?: string;
    description?: string;
    cover_image_url?: string;
    display_order?: number;
    published?: boolean;
    items?: Array<{ essay_slug: string; position: number; annotation?: string }>;
  };

  // Build update object — only include provided fields
  const updates: Record<string, unknown> = {};
  if (title !== undefined) updates.title = title;
  if (description !== undefined) updates.description = description;
  if (cover_image_url !== undefined) updates.cover_image_url = cover_image_url;
  if (display_order !== undefined) updates.display_order = display_order;
  if (published !== undefined) updates.published = published;

  if (Object.keys(updates).length > 0) {
    const { error: updateErr } = await supabase
      .from("reading_lists")
      .update(updates)
      .eq("id", list.id);
    if (updateErr) {
      console.error("[admin/reading-lists PATCH] update error:", updateErr);
      res.status(500).json({ error: "Failed to update reading list" });
      return;
    }
  }

  // Replace items if provided (supports full reorder)
  if (items !== undefined) {
    // Delete all existing items for this list
    await supabase.from("reading_list_items").delete().eq("list_id", list.id);

    if (items.length > 0) {
      const rows = items.map((item) => ({
        list_id: list.id,
        essay_slug: item.essay_slug,
        position: item.position,
        annotation: item.annotation ?? null,
      }));
      const { error: itemsErr } = await supabase.from("reading_list_items").insert(rows);
      if (itemsErr) {
        console.error("[admin/reading-lists PATCH] items replace error:", itemsErr);
        res.status(500).json({ error: "List fields updated but items replacement failed" });
        return;
      }
    }
  }

  res.json({ ok: true, slug });
});

/**
 * GET /api/admin/reading-lists
 *
 * Returns all reading lists (published and unpublished) for admin UI.
 * Auth: X-Admin-Secret header.
 */
app.get("/api/admin/reading-lists", requireAdminSecret, async (_req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }

  const { data: lists, error: listsErr } = await supabase
    .from("reading_lists")
    .select("id, slug, title, description, cover_image_url, display_order, published, created_at")
    .order("display_order", { ascending: true });

  if (listsErr) {
    console.error("[admin/reading-lists GET] error:", listsErr);
    res.status(500).json({ error: "Failed to load reading lists" });
    return;
  }

  if (!lists || lists.length === 0) {
    res.json({ reading_lists: [] });
    return;
  }

  const listIds = lists.map((l) => l.id);
  const { data: items } = await supabase
    .from("reading_list_items")
    .select("list_id, essay_slug, position, annotation")
    .in("list_id", listIds)
    .order("position", { ascending: true });

  const itemsByList: Record<string, Array<{ essay_slug: string; position: number; annotation: string | null }>> = {};
  for (const item of items ?? []) {
    if (!itemsByList[item.list_id]) itemsByList[item.list_id] = [];
    itemsByList[item.list_id].push({ essay_slug: item.essay_slug, position: item.position, annotation: item.annotation });
  }

  const reading_lists = lists.map((list) => ({
    ...list,
    items: itemsByList[list.id] ?? [],
  }));

  res.json({ reading_lists });
});

// ─── Start ────────────────────────────────────────────────────────────────────

validateConfig();
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Newsletter pipeline listening on http://127.0.0.1:${PORT}`);
  console.log(`  Full-list send: ${ALLOW_FULL_LIST_SEND ? "✅ ENABLED" : "🔒 BLOCKED"}`);
  console.log(`  Audience: ${RESEND_AUDIENCE_ID}`);
  console.log(`  From: ${EMAIL_FROM}`);
});

export { app };
