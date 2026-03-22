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
import { createHmac, timingSafeEqual, randomUUID } from "crypto";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import PDFDocument from "pdfkit";
import { readFileSync, writeFileSync, existsSync } from "fs";
import OpenAI from "openai";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import multer from "multer";
import Papa from "papaparse";

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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWITTER_API_KEY = process.env.TWITTER_API_KEY;
const TWITTER_API_SECRET = process.env.TWITTER_API_SECRET;
const TWITTER_ACCESS_TOKEN = process.env.TWITTER_ACCESS_TOKEN;
const TWITTER_ACCESS_SECRET = process.env.TWITTER_ACCESS_SECRET;
const SITE_URL_SOCIAL = "https://paradoxofacceptance.xyz";
const GOOGLE_SEARCH_CONSOLE_SITE_TOKEN = process.env.GOOGLE_SEARCH_CONSOLE_SITE_TOKEN;
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL;

// ─── Slug helpers ─────────────────────────────────────────────────────────────

/** Convert a newsletter subject to a URL-safe slug. Max 80 chars. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 80);
}

/**
 * Generate a unique slug for a newsletter send.
 * Falls back to empty string if Supabase is not configured.
 */
async function generateNewsletterSlug(
  subject: string,
  supabaseClient: typeof supabase
): Promise<string> {
  if (!supabaseClient) return "";
  const base = slugify(subject);
  if (!base) return "";
  let slug = base;
  let attempt = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data } = await supabaseClient
      .from("newsletter_sends")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (!data) return slug;
    attempt++;
    slug = `${base}-${attempt}`;
  }
}

// ─── Supabase (optional — for send log) ──────────────────────────────────────

let supabase: SupabaseClient | null = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ─── OpenAI (optional — for essay embeddings) ────────────────────────────────

let openaiClient: OpenAI | null = null;
if (OPENAI_API_KEY) {
  openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
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
  if (!OPENAI_API_KEY) {
    console.warn("⚠️  OPENAI_API_KEY not set — essay embeddings and related essays will use tag-based fallback only");
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

// ─── Suppression check ────────────────────────────────────────────────────────

/**
 * Returns true if the given email address is suppressed (should not receive mail).
 * Suppressed = status is anything other than 'active'.
 * Returns false if the subscriber row is not found (unknown address — allow send).
 */
async function isSuppressed(email: string): Promise<{ suppressed: boolean; status: string | null }> {
  if (!supabase) return { suppressed: false, status: null };
  const { data, error } = await supabase
    .from("subscribers")
    .select("status")
    .eq("email", email.toLowerCase().trim())
    .maybeSingle();
  if (error || !data) return { suppressed: false, status: null };
  const suppressed = data.status !== "active";
  return { suppressed, status: data.status as string };
}

/**
 * Log an individual email send attempt to email_send_log.
 * Non-fatal — never throws.
 */
async function logEmailSend(
  email: string,
  type: string,
  status: "sent" | "skipped" | "failed",
  opts: { skipReason?: string; resendEmailId?: string } = {}
): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.from("email_send_log").insert({
      email: email.toLowerCase().trim(),
      type,
      status,
      skip_reason: opts.skipReason ?? null,
      resend_email_id: opts.resendEmailId ?? null,
    });
  } catch {
    // Silently ignore logging errors
  }
}

// ─── Sentry alert helper ──────────────────────────────────────────────────────

/**
 * Sends an alert to Sentry via the HTTP Store API (no SDK required).
 * Set SENTRY_DSN to enable. No-ops silently if unset.
 */
async function captureSentryAlert(
  message: string,
  level: "warning" | "error",
  extra: Record<string, unknown>
): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.warn(`[sentry-alert] SENTRY_DSN not set — alert not sent: ${message}`);
    return;
  }
  // Parse DSN: https://PUBLIC_KEY@HOST/PROJECT_ID
  const match = dsn.match(/^https?:\/\/([^@]+)@([^/]+)\/(.+)$/);
  if (!match) {
    console.error("[sentry-alert] Invalid SENTRY_DSN format");
    return;
  }
  const [, publicKey, host, projectId] = match;
  const storeUrl = `https://${host}/api/${projectId}/store/`;
  try {
    await fetch(storeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_client=newsletter-server/1.0, sentry_key=${publicKey}`,
      },
      body: JSON.stringify({
        message,
        level,
        platform: "node",
        extra,
        timestamp: new Date().toISOString().replace("Z", ""),
      }),
    });
    console.log(`[sentry-alert] Captured: ${message} (${level})`);
  } catch (err) {
    console.error("[sentry-alert] Failed to capture:", err);
  }
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
  slug?: string;
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
    slug: entry.slug || null,
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
  // Suppression check: skip if previously bounced or unsubscribed
  const { suppressed, status } = await isSuppressed(email);
  if (suppressed) {
    console.log(`[subscribe] Skipping welcome email for ${email} — suppressed (status=${status})`);
    await logEmailSend(email, "welcome", "skipped", { skipReason: status ?? undefined });
    return;
  }

  const token = generateUnsubscribeToken(email);
  const html = buildWelcomeHtml(email, token);
  const greeting = firstName ? `${firstName.trim()},` : "";
  const subject = greeting ? `Welcome, ${firstName?.trim()}` : "Welcome to Paradox of Acceptance";

  const { data, error } = await resend.emails.send({
    from: EMAIL_FROM!,
    to: email,
    replyTo: EMAIL_REPLY_TO || undefined,
    subject,
    html,
  });

  if (error) {
    console.error(`[subscribe] Welcome email failed for ${email}:`, error);
    await logEmailSend(email, "welcome", "failed");
  } else {
    console.log(`[subscribe] Welcome email sent to ${email}`);
    await logEmailSend(email, "welcome", "sent", { resendEmailId: data?.id });
  }
}

// ─── CSV Bulk Import ─────────────────────────────────────────────────────────

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "text/csv" || file.originalname.endsWith(".csv")) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are accepted"));
    }
  },
});

type ImportJobStatus = "running" | "done" | "failed";

interface ImportJob {
  id: string;
  status: ImportJobStatus;
  total: number;
  processed: number;
  imported: number;
  skipped_duplicates: number;
  failed: number;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

// In-memory job store (single-process; sufficient for admin one-off imports)
const importJobs = new Map<string, ImportJob>();

/**
 * Resolve the email column from CSV headers (case-insensitive, supports "e-mail").
 */
function findEmailColumn(headers: string[]): string | undefined {
  return headers.find((h) => /^e-?mail$/i.test(h));
}

/**
 * Minimal RFC-5322-ish email validation.
 */
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * Core import runner — runs in background after the HTTP response is sent.
 */
async function runCsvImport(
  jobId: string,
  rows: Array<Record<string, string>>,
  emailCol: string,
  firstNameCol: string | undefined,
  lastNameCol: string | undefined
): Promise<void> {
  const job = importJobs.get(jobId)!;
  const resend = new Resend(RESEND_API_KEY!);

  // Fetch existing subscriber emails from Supabase for dedup
  const existingEmails = new Set<string>();
  if (supabase) {
    const { data: subs } = await supabase.from("subscribers").select("email");
    for (const row of subs ?? []) {
      existingEmails.add(String(row.email).toLowerCase().trim());
    }
  }

  // Deduplicate within the CSV itself (keep first occurrence)
  const seenInCsv = new Set<string>();
  const toProcess: Array<{ email: string; firstName?: string }> = [];

  for (const row of rows) {
    const raw = row[emailCol] ?? "";
    const email = raw.toLowerCase().trim();
    if (!email || !isValidEmail(email)) {
      job.failed++;
      job.processed++;
      continue;
    }
    if (seenInCsv.has(email) || existingEmails.has(email)) {
      job.skipped_duplicates++;
      job.processed++;
      continue;
    }
    seenInCsv.add(email);

    let firstName: string | undefined;
    if (firstNameCol) {
      const fn = (row[firstNameCol] ?? "").trim();
      const ln = lastNameCol ? (row[lastNameCol] ?? "").trim() : "";
      firstName = ln ? `${fn} ${ln}`.trim() : fn || undefined;
    }

    toProcess.push({ email, firstName });
  }

  job.total = rows.length;

  // Batch to Resend in groups of 100
  const BATCH = 100;
  for (let i = 0; i < toProcess.length; i += BATCH) {
    const batch = toProcess.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map((c) =>
        resend.contacts.create({
          audienceId: RESEND_AUDIENCE_ID!,
          email: c.email,
          firstName: c.firstName,
          unsubscribed: false,
        })
      )
    );
    for (const r of results) {
      if (r.status === "fulfilled" && !r.value.error) {
        job.imported++;
      } else {
        job.failed++;
      }
      job.processed++;
    }
    // Respect rate limits
    if (i + BATCH < toProcess.length) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  job.status = "done";
  job.completedAt = new Date().toISOString();

  // Persist job record to Supabase
  if (supabase) {
    await supabase.from("bulk_import_jobs").insert({
      id: jobId,
      status: job.status,
      total_rows: job.total,
      imported: job.imported,
      skipped_duplicates: job.skipped_duplicates,
      failed_rows: job.failed,
      created_at: job.createdAt,
      completed_at: job.completedAt,
    });
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
  const { email, firstName, source } = req.body as { email?: string; firstName?: string; source?: string };

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
  const safeSource = source ? ` [source: ${source}]` : "";
  console.log(`[subscribe] ${email} added to audience${safeSource}`);

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
      slug: await generateNewsletterSlug(subject, supabase),
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
    slug: await generateNewsletterSlug(subject, supabase),
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

// ─── Newsletter Drafts CRUD ───────────────────────────────────────────────────
//
// Supports /admin/newsletter/compose — auto-saved drafts stored in Supabase.
// All endpoints require X-Admin-Secret header.

/**
 * POST /api/newsletter/drafts
 * Creates a new newsletter draft. Returns the created draft.
 */
app.post("/api/newsletter/drafts", requireAdminSecret, async (req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }
  const { subject = "", previewText = "", htmlBody = "" } = req.body as {
    subject?: string;
    previewText?: string;
    htmlBody?: string;
  };
  const { data, error } = await supabase
    .from("newsletter_drafts")
    .insert({ subject, preview_text: previewText, html_body: htmlBody })
    .select("id, subject, preview_text, html_body, updated_at, created_at")
    .single();
  if (error) {
    res.status(500).json({ error: "Failed to create draft", detail: error });
    return;
  }
  res.status(201).json({ draft: data });
});

/**
 * GET /api/newsletter/drafts
 * Returns all drafts ordered by most recently updated, without html_body.
 */
app.get("/api/newsletter/drafts", requireAdminSecret, async (_req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }
  const { data, error } = await supabase
    .from("newsletter_drafts")
    .select("id, subject, preview_text, updated_at, created_at")
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) {
    res.status(500).json({ error: "Failed to fetch drafts", detail: error });
    return;
  }
  res.json({ drafts: data ?? [] });
});

/**
 * GET /api/newsletter/drafts/:id
 * Returns a single draft including html_body.
 */
app.get("/api/newsletter/drafts/:id", requireAdminSecret, async (req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }
  const { id } = req.params;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    res.status(400).json({ error: "Invalid draft id" });
    return;
  }
  const { data, error } = await supabase
    .from("newsletter_drafts")
    .select("id, subject, preview_text, html_body, updated_at, created_at")
    .eq("id", id)
    .single();
  if (error || !data) {
    res.status(404).json({ error: "Draft not found" });
    return;
  }
  res.json({ draft: data });
});

/**
 * PATCH /api/newsletter/drafts/:id
 * Partial update — updates any combination of subject, previewText, htmlBody.
 */
app.patch("/api/newsletter/drafts/:id", requireAdminSecret, async (req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }
  const { id } = req.params;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    res.status(400).json({ error: "Invalid draft id" });
    return;
  }
  const { subject, previewText, htmlBody } = req.body as {
    subject?: string;
    previewText?: string;
    htmlBody?: string;
  };
  const updates: Record<string, string> = { updated_at: new Date().toISOString() };
  if (subject !== undefined) updates.subject = subject;
  if (previewText !== undefined) updates.preview_text = previewText;
  if (htmlBody !== undefined) updates.html_body = htmlBody;
  const { data, error } = await supabase
    .from("newsletter_drafts")
    .update(updates)
    .eq("id", id)
    .select("id, subject, preview_text, updated_at")
    .single();
  if (error || !data) {
    res.status(404).json({ error: "Draft not found or update failed" });
    return;
  }
  res.json({ draft: data });
});

/**
 * DELETE /api/newsletter/drafts/:id
 * Deletes a draft permanently.
 */
app.delete("/api/newsletter/drafts/:id", requireAdminSecret, async (req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }
  const { id } = req.params;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    res.status(400).json({ error: "Invalid draft id" });
    return;
  }
  const { error } = await supabase
    .from("newsletter_drafts")
    .delete()
    .eq("id", id);
  if (error) {
    res.status(500).json({ error: "Failed to delete draft" });
    return;
  }
  res.json({ ok: true });
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
    .select("id, slug, subject, preview_text, sent_at, recipient_count")
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
    .select("id, slug, subject, preview_text, sent_at, recipient_count, body_html, body_text")
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

// ─── GET /api/newsletter/archive/slug/:slug ────────────────────────────────────

/**
 * GET /api/newsletter/archive/slug/:slug
 *
 * Public endpoint. Returns the full HTML body of a past newsletter issue by slug.
 * Only serves rows that are non-test, sent, and include_in_archive=true.
 */
app.options("/api/newsletter/archive/slug/:slug", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

app.get("/api/newsletter/archive/slug/:slug", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }

  const { slug } = req.params;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    res.status(400).json({ error: "Invalid issue slug" });
    return;
  }

  const { data, error } = await supabase
    .from("newsletter_sends")
    .select("id, slug, subject, preview_text, sent_at, recipient_count, body_html, body_text")
    .eq("slug", slug)
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

// ─── GET /newsletter/:slug — browser preview (HTML) ───────────────────────────

/**
 * GET /newsletter/:slug
 *
 * Server-side rendered newsletter browser preview page.
 * Returns a full HTML document with canonical link, OG tags, and subscribe CTA.
 * Only serves public, non-test, sent, include_in_archive=true rows.
 *
 * Requires nginx (or reverse proxy) to route /newsletter/:slug to this server.
 * Static paths /newsletter/ and /newsletter/issue/ are still served by GitHub Pages.
 */
app.get("/newsletter/:slug([a-z0-9-]+)", async (req: Request, res: Response) => {
  if (!supabase) {
    res.redirect("/newsletter/");
    return;
  }

  const { slug } = req.params;

  const { data, error } = await supabase
    .from("newsletter_sends")
    .select("id, slug, subject, preview_text, sent_at, recipient_count, body_html, body_text")
    .eq("slug", slug)
    .eq("test_mode", false)
    .eq("status", "sent")
    .eq("include_in_archive", true)
    .single();

  if (error || !data) {
    res.status(404).send(renderNewsletterNotFound());
    return;
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderNewsletterIssue(data));
});

/** Format an ISO date string as "Month D, YYYY". */
function formatIssueDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

/** Escape HTML for safe text insertion. */
function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Render the full HTML page for a newsletter issue. */
function renderNewsletterIssue(issue: {
  id: string;
  slug: string | null;
  subject: string;
  preview_text: string | null;
  sent_at: string;
  recipient_count: number;
  body_html: string | null;
  body_text: string | null;
}): string {
  const canonicalSlug = issue.slug ?? issue.id;
  const canonicalUrl = `${SERVER_URL}/newsletter/${canonicalSlug}/`;
  const title = escHtml(issue.subject);
  const description = issue.preview_text ? escHtml(issue.preview_text) : `Newsletter issue — ${formatIssueDate(issue.sent_at)}`;
  const dateStr = formatIssueDate(issue.sent_at);

  // Sanitize body: strip <script> tags server-side as a basic precaution.
  // DOMPurify runs client-side for full sanitization.
  const rawBody = issue.body_html ?? (issue.body_text ? `<p>${escHtml(issue.body_text)}</p>` : "");
  const safeBody = rawBody.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} — Paradox of Acceptance</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonicalUrl}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:type" content="article">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:site_name" content="Paradox of Acceptance">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<link rel="alternate" type="application/atom+xml" title="Paradox of Acceptance" href="/feed.xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/shared/design-tokens.css">
<link rel="stylesheet" href="/shared/theme-mono.css">
<script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
<script defer data-domain="paradoxofacceptance.xyz" src="https://plausible.io/js/script.js"></script>
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
html { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: #FFFFFF; color: #111111; }
a { color: inherit; text-decoration: none; }

.nav { display: flex; align-items: center; justify-content: space-between; padding: 24px 280px; }
.page-content { padding: 48px 280px 80px; max-width: 1200px; margin: 0 auto; }
.issue-body-wrap { max-width: 680px; }
.footer { padding: 48px 280px; }

.nav-logo { font-family: 'Newsreader', serif; font-size: 20px; font-weight: 500; color: #111; }
.nav-links { display: flex; align-items: center; gap: 36px; }
.nav-links a { font-size: 13px; font-weight: 500; color: #666; transition: color 0.15s; }
.nav-links a:hover { color: #111; }

.divider { border: none; border-top: 1px solid #EEEEEE; margin: 0; }

.back-link { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: #999; margin-bottom: 36px; transition: color 0.15s; }
.back-link:hover { color: #666; }

.issue-subject { font-family: 'Newsreader', serif; font-size: 36px; font-weight: 400; color: #111; line-height: 1.25; margin-bottom: 12px; }
.issue-meta { font-size: 13px; color: #999; margin-bottom: 40px; }

/* Subscribe CTA */
.subscribe-cta { background: #F7F7F7; border: 1px solid #EEEEEE; border-radius: 6px; padding: 20px 24px; margin-bottom: 36px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.subscribe-cta-text { font-size: 14px; color: #555; }
.subscribe-cta-text strong { color: #111; }
.subscribe-cta-form { display: inline-flex; border: 1px solid #DDD; border-radius: 4px; overflow: hidden; background: #fff; }
.subscribe-cta-input { font-family: 'Inter', sans-serif; font-size: 13px; padding: 9px 14px; border: none; outline: none; width: 220px; }
.subscribe-cta-btn { font-family: 'Inter', sans-serif; font-size: 13px; font-weight: 500; padding: 9px 18px; background: #111; color: #fff; border: none; cursor: pointer; transition: background 0.15s; white-space: nowrap; }
.subscribe-cta-btn:hover { background: #333; }
.subscribe-cta-btn:disabled { background: #666; cursor: default; }
.subscribe-cta-msg { font-size: 12px; margin-top: 6px; min-height: 16px; }
.subscribe-cta-msg.success { color: #22C55E; }
.subscribe-cta-msg.error { color: #DC2626; }

/* Bottom subscribe block */
.subscribe-bottom { border-top: 1px solid #EEEEEE; margin-top: 56px; padding-top: 48px; text-align: center; }
.subscribe-bottom-headline { font-family: 'Newsreader', serif; font-size: 28px; font-weight: 400; color: #111; margin-bottom: 10px; }
.subscribe-bottom-sub { font-size: 15px; color: #666; margin-bottom: 24px; line-height: 1.6; }
.subscribe-bottom-form { display: inline-flex; border: 1px solid #DDD; border-radius: 4px; overflow: hidden; }
.subscribe-bottom-input { font-family: 'Inter', sans-serif; font-size: 14px; padding: 12px 16px; border: none; outline: none; width: 280px; }
.subscribe-bottom-btn { font-family: 'Inter', sans-serif; font-size: 14px; font-weight: 500; padding: 12px 24px; background: #111; color: #fff; border: none; cursor: pointer; transition: background 0.15s; }
.subscribe-bottom-btn:hover { background: #333; }
.subscribe-bottom-btn:disabled { background: #666; cursor: default; }
.subscribe-bottom-msg { font-size: 13px; margin-top: 12px; min-height: 20px; }
.subscribe-bottom-msg.success { color: #22C55E; }
.subscribe-bottom-msg.error { color: #DC2626; }

/* Email body */
.email-body-container { border: 1px solid #EEEEEE; border-radius: 6px; padding: 40px; background: #FAFAFA; overflow: hidden; }
.email-body-container * { max-width: 100%; }
.email-body-container a { color: #111; text-decoration: underline; }
.email-body-container p { line-height: 1.7; margin-bottom: 16px; color: #333; font-size: 16px; }
.email-body-container h1, .email-body-container h2, .email-body-container h3 {
  font-family: 'Newsreader', serif; font-weight: 400; color: #111; margin-bottom: 12px; margin-top: 32px; line-height: 1.3;
}
.email-body-container h1 { font-size: 28px; }
.email-body-container h2 { font-size: 24px; }
.email-body-container h3 { font-size: 20px; }
.email-body-container ul, .email-body-container ol { padding-left: 24px; margin-bottom: 16px; }
.email-body-container li { line-height: 1.7; margin-bottom: 6px; color: #333; font-size: 16px; }
.email-body-container blockquote { border-left: 3px solid #DDD; padding-left: 16px; margin: 24px 0; color: #666; font-style: italic; }
.email-body-container hr { border: none; border-top: 1px solid #EEE; margin: 32px 0; }
.email-body-container img { border-radius: 4px; }
.email-body-container table { max-width: 100%; border-collapse: collapse; }

.footer { display: flex; align-items: center; justify-content: space-between; border-top: 1px solid #EEEEEE; padding-top: 24px; padding-bottom: 24px; }
.footer-logo { font-family: 'Newsreader', serif; font-size: 16px; color: #111; }
.footer-links { display: flex; flex-wrap: wrap; gap: 24px; }
.footer-links a { font-size: 13px; color: #666; transition: color 0.15s; }
.footer-links a:hover { color: #111; }

@media (max-width: 900px) {
  .nav, .page-content, .footer { padding-left: 24px; padding-right: 24px; }
  .issue-subject { font-size: 28px; }
  .nav-links { gap: 20px; }
  .email-body-container { padding: 24px; }
  .footer { flex-direction: column; gap: 16px; align-items: flex-start; }
  .footer-links { gap: 16px; }
  .subscribe-cta { flex-direction: column; align-items: flex-start; }
  .subscribe-cta-form { width: 100%; }
  .subscribe-cta-input { flex: 1; }
  .subscribe-bottom-form { flex-direction: column; width: 100%; max-width: 320px; }
  .subscribe-bottom-input { width: 100%; }
  .subscribe-bottom-btn { width: 100%; }
}
</style>
</head>
<body>

<nav class="nav">
  <div style="display:flex;align-items:center;gap:48px;">
    <a href="/" class="nav-logo">Paradox of Acceptance</a>
    <div class="nav-links">
      <a href="/#start-here">Tools</a>
      <a href="/mindfulness-essays/">Essays</a>
      <a href="/mindfulness-wiki/">Wiki</a>
      <a href="/newsletter/">Newsletter</a>
      <a href="/pass/">Pass</a>
    </div>
  </div>
</nav>

<hr class="divider">

<div class="page-content">
  <a href="/newsletter/" class="back-link">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
    All issues
  </a>

  <!-- Top subscribe CTA -->
  <div class="subscribe-cta">
    <div>
      <div class="subscribe-cta-text"><strong>Paradox of Acceptance</strong> — essays and tools for the questions practice raises.</div>
      <div class="subscribe-cta-msg" id="cta-top-msg"></div>
    </div>
    <form class="subscribe-cta-form" onsubmit="handleSubscribe(event,'top')">
      <input class="subscribe-cta-input" type="email" id="cta-top-email" placeholder="you@email.com" required>
      <button class="subscribe-cta-btn" type="submit" id="cta-top-btn">Subscribe free</button>
    </form>
  </div>

  <div class="issue-body-wrap">
    <h1 class="issue-subject">${title}</h1>
    <div class="issue-meta">${dateStr}</div>
    <div class="email-body-container" id="issue-body">
      ${safeBody}
    </div>

    <!-- Bottom subscribe CTA -->
    <div class="subscribe-bottom">
      <div class="subscribe-bottom-headline">Stay with the questions</div>
      <p class="subscribe-bottom-sub">Essays and tools for meditators navigating what mindfulness actually does to a person.<br>New issues when they&rsquo;re ready. No spam.</p>
      <form class="subscribe-bottom-form" onsubmit="handleSubscribe(event,'bottom')">
        <input class="subscribe-bottom-input" type="email" id="cta-bottom-email" placeholder="you@email.com" required>
        <button class="subscribe-bottom-btn" type="submit" id="cta-bottom-btn">Subscribe</button>
      </form>
      <div class="subscribe-bottom-msg" id="cta-bottom-msg"></div>
    </div>
  </div>
</div>

<footer class="footer">
  <div class="footer-logo">Paradox of Acceptance</div>
  <div class="footer-links">
    <a href="/meditation-quiz/">Quiz</a>
    <a href="/meditation-debates/">Debates</a>
    <a href="/teacher-debates/">Teacher Map</a>
    <a href="/meditation-recommender/">Recommender</a>
    <a href="/mindfulness-essays/">Essays</a>
    <a href="/mindfulness-pointers/">Pointers</a>
    <a href="/mindfulness-wiki/">Wiki</a>
    <a href="/newsletter/">Newsletter</a>
    <a href="/about/">About</a>
    <a href="/pass/">Pass</a>
    <a href="https://x.com/quiet_drift" target="_blank" rel="noopener">Twitter / X</a>
    <a href="/feed.xml"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="vertical-align:-1px;margin-right:3px"><circle cx="6.18" cy="17.82" r="2.18"/><path d="M4 4.44v2.83c7.03 0 12.73 5.7 12.73 12.73h2.83c0-8.59-6.97-15.56-15.56-15.56zm0 5.66v2.83c3.9 0 7.07 3.17 7.07 7.07h2.83c0-5.47-4.43-9.9-9.9-9.9z"/></svg>RSS Feed</a>
    <a href="/privacy/">Privacy</a>
    <a href="/terms/">Terms</a>
  </div>
</footer>

<script>
(function() {
  var API_BASE = '${SERVER_URL}';

  // Client-side DOMPurify sanitization (belt-and-suspenders on top of server-side strip)
  var body = document.getElementById('issue-body');
  if (body && typeof DOMPurify !== 'undefined') {
    body.innerHTML = DOMPurify.sanitize(body.innerHTML, {
      FORBID_TAGS: ['script', 'object', 'embed', 'form', 'input', 'textarea', 'select', 'button'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur', 'onchange'],
      ALLOW_DATA_ATTR: false
    });
  }

  window.handleSubscribe = function(e, position) {
    e.preventDefault();
    var emailId = position === 'top' ? 'cta-top-email' : 'cta-bottom-email';
    var btnId   = position === 'top' ? 'cta-top-btn'   : 'cta-bottom-btn';
    var msgId   = position === 'top' ? 'cta-top-msg'   : 'cta-bottom-msg';
    var email = document.getElementById(emailId).value.trim();
    var btn   = document.getElementById(btnId);
    var msg   = document.getElementById(msgId);
    if (!email) return;
    btn.disabled = true;
    btn.textContent = '...';
    msg.textContent = '';
    msg.className = position === 'top' ? 'subscribe-cta-msg' : 'subscribe-bottom-msg';

    fetch(API_BASE + '/api/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email })
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        btn.disabled = false;
        btn.textContent = position === 'top' ? 'Subscribe free' : 'Subscribe';
        if (data.error) {
          msg.textContent = 'Something went wrong. Try again.';
          msg.className = (position === 'top' ? 'subscribe-cta-msg' : 'subscribe-bottom-msg') + ' error';
        } else {
          window.plausible && window.plausible('Subscribe', { props: { source: 'newsletter-preview-' + position } });
          msg.textContent = "You're in. Welcome.";
          msg.className = (position === 'top' ? 'subscribe-cta-msg' : 'subscribe-bottom-msg') + ' success';
          document.getElementById(emailId).value = '';
        }
      })
      .catch(function() {
        btn.disabled = false;
        btn.textContent = position === 'top' ? 'Subscribe free' : 'Subscribe';
        msg.textContent = 'Something went wrong. Try again.';
        msg.className = (position === 'top' ? 'subscribe-cta-msg' : 'subscribe-bottom-msg') + ' error';
      });
  };
})();
</script>
</body>
</html>`;
}

/** Render a 404 page for an unknown newsletter slug. */
function renderNewsletterNotFound(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Issue not found — Paradox of Acceptance</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/shared/design-tokens.css">
<link rel="stylesheet" href="/shared/theme-mono.css">
<style>
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: #FFFFFF; color: #111111; }
a { color: inherit; text-decoration: none; }
.nav { display: flex; align-items: center; padding: 24px 280px; }
.nav-logo { font-family: 'Newsreader', serif; font-size: 20px; font-weight: 500; color: #111; }
.divider { border: none; border-top: 1px solid #EEEEEE; margin: 0; }
.page-content { padding: 80px 280px; text-align: center; }
.not-found-title { font-family: 'Newsreader', serif; font-size: 36px; font-weight: 400; color: #111; margin-bottom: 12px; }
.not-found-sub { font-size: 15px; color: #666; margin-bottom: 28px; }
.not-found-link { font-size: 14px; color: #111; text-decoration: underline; }
@media (max-width: 900px) { .nav, .page-content { padding-left: 24px; padding-right: 24px; } }
</style>
</head>
<body>
<nav class="nav"><a href="/" class="nav-logo">Paradox of Acceptance</a></nav>
<hr class="divider">
<div class="page-content">
  <div class="not-found-title">Issue not found</div>
  <p class="not-found-sub">This newsletter issue isn&rsquo;t in the public archive.</p>
  <a href="/newsletter/" class="not-found-link">Browse all issues</a>
</div>
</body>
</html>`;
}

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

// ─── Essay embedding helpers ──────────────────────────────────────────────────

interface RelatedEssay {
  slug: string;
  title: string;
  description: string | null;
  kicker: string | null;
  read_time: string | null;
  path: string;
  tags: string[];
  similarity?: number;
}

/** Generate a text-embedding-3-small vector for the given text. */
async function generateEssayEmbedding(text: string): Promise<number[] | null> {
  if (!openaiClient) return null;
  const response = await openaiClient.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
    dimensions: 1536,
  });
  if (supabase) {
    const usage = response.usage;
    await supabase.from("openai_usage").insert({
      model: "text-embedding-3-small",
      operation: "essay_embedding",
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: 0,
      total_tokens: usage.total_tokens,
    });
  }
  return response.data[0].embedding;
}

/** Store or update an embedding for an essay slug. */
async function upsertEssayEmbedding(slug: string, bodyMarkdown: string): Promise<void> {
  if (!supabase) return;
  const embedding = await generateEssayEmbedding(bodyMarkdown);
  if (!embedding) return;
  const { error } = await supabase.from("essay_embeddings").upsert(
    { essay_slug: slug, embedding: JSON.stringify(embedding), generated_at: new Date().toISOString() },
    { onConflict: "essay_slug" }
  );
  if (error) {
    console.error(`[embeddings] upsert error for ${slug}:`, error);
  }
  // Bust the related cache for this essay and any essay that cached it
  await supabase.from("related_essays_cache").delete().eq("slug", slug);
}

/** Tag-based fallback: return essays sharing >= 2 tags with the given slug. */
async function tagBasedRelatedEssays(slug: string, limit: number): Promise<RelatedEssay[]> {
  if (!supabase) return [];
  // Fetch tags for the source essay
  const { data: src } = await supabase
    .from("essays")
    .select("tags")
    .eq("slug", slug)
    .single();

  if (!src?.tags?.length) return [];

  // Fetch all other published essays
  const { data: others } = await supabase
    .from("essays")
    .select("slug, title, description, kicker, read_time, path, tags")
    .neq("slug", slug)
    .not("published_at", "is", null)
    .lte("published_at", new Date().toISOString());

  if (!others) return [];

  // Score by shared tags
  const scored = others
    .map((e) => {
      const shared = (e.tags as string[]).filter((t: string) => (src.tags as string[]).includes(t)).length;
      return { ...e, sharedTags: shared };
    })
    .filter((e) => e.sharedTags >= 2)
    .sort((a, b) => b.sharedTags - a.sharedTags)
    .slice(0, limit);

  return scored.map(({ sharedTags: _st, ...rest }) => rest as RelatedEssay);
}

/** Compute related essays for a slug using vector similarity (with tag fallback). */
async function computeRelatedEssays(slug: string): Promise<RelatedEssay[]> {
  if (!supabase) return [];

  // Check if embeddings exist for this slug
  const { data: srcEmb } = await supabase
    .from("essay_embeddings")
    .select("essay_slug")
    .eq("essay_slug", slug)
    .maybeSingle();

  if (srcEmb) {
    const { data, error } = await supabase.rpc("find_related_essays", {
      p_slug: slug,
      p_limit: 4,
    });
    if (!error && data && (data as RelatedEssay[]).length >= 2) {
      return data as RelatedEssay[];
    }
  }

  // Fallback to tag-based
  return tagBasedRelatedEssays(slug, 4);
}

// ─── GET /api/essays/:slug/related ───────────────────────────────────────────

/**
 * GET /api/essays/:slug/related
 *
 * Returns up to 4 related essays for the given slug.
 * Uses pgvector cosine similarity when embeddings exist; falls back to tag
 * overlap (>= 2 shared tags). Results cached in related_essays_cache for 24h.
 *
 * No auth required — called from public essay pages.
 */

app.options("/api/essays/:slug/related", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.sendStatus(204);
});

app.get("/api/essays/:slug/related", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const { slug } = req.params;
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
    res.status(400).json({ error: "Invalid slug" });
    return;
  }

  if (!supabase) {
    res.status(503).json({ error: "Database not configured" });
    return;
  }

  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

  // Check cache
  const { data: cached } = await supabase
    .from("related_essays_cache")
    .select("related, generated_at")
    .eq("slug", slug)
    .maybeSingle();

  if (
    cached?.related &&
    Date.now() - new Date(cached.generated_at as string).getTime() < CACHE_TTL_MS
  ) {
    res.json({ essays: cached.related, source: "cache" });
    return;
  }

  // Compute fresh results
  const related = await computeRelatedEssays(slug);

  // Write cache
  await supabase.from("related_essays_cache").upsert(
    { slug, related, generated_at: new Date().toISOString() },
    { onConflict: "slug" }
  );

  res.json({ essays: related, source: "computed" });
});

// ─── POST /api/admin/essays/seed-embeddings ───────────────────────────────────

/**
 * POST /api/admin/essays/seed-embeddings
 *
 * Background job: generates embeddings for all published essays that don't
 * have one yet. Batches calls with a 1s delay between them to respect OpenAI
 * rate limits. Safe to call multiple times (idempotent — skips existing embeddings).
 *
 * Auth: X-Admin-Secret header.
 * Response: immediate acknowledgement; processing continues in background.
 */
app.post("/api/admin/essays/seed-embeddings", requireAdminSecret, async (_req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }
  if (!openaiClient) {
    res.status(503).json({ error: "OPENAI_API_KEY not configured" });
    return;
  }

  // Fetch all published essays with body_markdown
  const { data: essays, error } = await supabase
    .from("essays")
    .select("slug, body_markdown")
    .not("published_at", "is", null)
    .lte("published_at", new Date().toISOString());

  if (error || !essays) {
    res.status(500).json({ error: "Failed to fetch essays" });
    return;
  }

  // Acknowledge immediately; run generation in background
  res.json({ ok: true, total: essays.length, message: "Embedding generation started in background" });

  for (const essay of essays as Array<{ slug: string; body_markdown: string | null }>) {
    if (!essay.body_markdown) continue;

    // Skip if embedding already exists
    const { data: existing } = await supabase
      .from("essay_embeddings")
      .select("essay_slug")
      .eq("essay_slug", essay.slug)
      .maybeSingle();

    if (existing) continue;

    await upsertEssayEmbedding(essay.slug, essay.body_markdown);
    console.log(`[seed-embeddings] Generated embedding for: ${essay.slug}`);

    // Rate-limit friendly: 1s between calls
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log("[seed-embeddings] Done");
});

// ─── GET /api/admin/essays  ───────────────────────────────────────────────────

/**
 * GET /api/admin/essays
 *
 * Returns all essays with their publishing status, ordered by published_at desc
 * then created_at desc. Falls back to the hardcoded ESSAYS list (with null
 * published_at / deployed_at) when Supabase is not configured.
 *
 * Optional query param:
 *   ?month=YYYY-MM  — filter to essays where published_at falls within that
 *                     calendar month (UTC). Drafts (published_at IS NULL) are
 *                     excluded when this param is provided.
 *
 * Auth: X-Admin-Secret header.
 */
app.get("/api/admin/essays", requireAdminSecret, async (req: Request, res: Response) => {
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

  const { month } = req.query as { month?: string };

  let query = supabase
    .from("essays")
    .select("slug, title, kicker, description, read_time, path, published_at, deployed_at, created_at, updated_at");

  if (month && /^\d{4}-\d{2}$/.test(month)) {
    // Filter to essays within the given calendar month (UTC)
    const [year, mon] = month.split("-").map(Number);
    const start = new Date(Date.UTC(year, mon - 1, 1)).toISOString();
    const end   = new Date(Date.UTC(year, mon, 1)).toISOString(); // exclusive start of next month
    query = query
      .not("published_at", "is", null)
      .gte("published_at", start)
      .lt("published_at", end);
  }

  const { data, error } = await query
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[admin/essays] Supabase error:", error);
    return res.status(500).json({ error: "Failed to load essays" });
  }

  res.json({ essays: data ?? [] });
});

// ─── POST /api/admin/essays ───────────────────────────────────────────────────

/**
 * POST /api/admin/essays
 *
 * Create a new essay (draft). Required fields: slug, title.
 * Optional: kicker, description, read_time, published_at.
 * The path is derived from the slug as /mindfulness-essays/{slug}/.
 *
 * Auth: X-Admin-Secret header.
 */
app.post("/api/admin/essays", requireAdminSecret, async (req: Request, res: Response) => {
  if (!supabase) {
    return res.status(503).json({ error: "Supabase not configured" });
  }

  const { slug, title, kicker, description, read_time, published_at } = req.body as {
    slug?: string;
    title?: string;
    kicker?: string;
    description?: string;
    read_time?: string;
    published_at?: string | null;
  };

  if (!slug || !title) {
    return res.status(400).json({ error: "slug and title are required" });
  }

  // Validate slug format
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return res.status(400).json({ error: "slug must be lowercase alphanumeric with hyphens" });
  }

  const path = `/mindfulness-essays/${slug}/`;

  const { data, error } = await supabase
    .from("essays")
    .insert({
      slug,
      title,
      kicker: kicker ?? null,
      description: description ?? null,
      read_time: read_time ?? null,
      path,
      published_at: published_at ?? null,
    })
    .select("slug, title, kicker, description, read_time, path, published_at, deployed_at, created_at, updated_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "An essay with that slug already exists" });
    }
    console.error("[admin/essays] create error:", error);
    return res.status(500).json({ error: "Failed to create essay" });
  }

  res.status(201).json({ essay: data });
});

// ─── SEO static-file helpers ──────────────────────────────────────────────────

const ESSAYS_BASE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "mindfulness-essays");

function escapeHtmlAttr(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripMarkdownExcerpt(text: string, maxLen = 160): string {
  return text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, maxLen);
}

/**
 * Updates the <head> SEO tags of a static essay HTML file.
 * Called after any PATCH or revert that changes title/SEO/body fields.
 * Non-fatal: logs a warning if the file is missing or write fails.
 */
function updateStaticEssayHead(slug: string, essay: {
  title: string;
  seo_title?: string | null;
  seo_description?: string | null;
  seo_keywords?: string[] | null;
  meta_description?: string | null;
  body_markdown?: string | null;
}): void {
  const htmlPath = join(ESSAYS_BASE_DIR, slug, "index.html");
  if (!existsSync(htmlPath)) {
    console.warn(`[seo] static file not found, skipping head update: ${htmlPath}`);
    return;
  }

  try {
    const effectiveTitle = essay.seo_title?.trim() || essay.title;
    const effectiveDescription =
      essay.seo_description?.trim() ||
      essay.meta_description?.trim() ||
      (essay.body_markdown ? stripMarkdownExcerpt(essay.body_markdown) : "");

    const t = escapeHtmlAttr(effectiveTitle);
    const d = escapeHtmlAttr(effectiveDescription);

    let html = readFileSync(htmlPath, "utf-8");

    // <title>
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${t}</title>`);

    // meta description
    html = html.replace(
      /<meta\s+name="description"\s+content="[^"]*"\s*\/>/,
      `<meta name="description" content="${d}" />`
    );

    // og:title
    html = html.replace(
      /<meta\s+property="og:title"\s+content="[^"]*"\s*\/>/,
      `<meta property="og:title" content="${t}" />`
    );

    // og:description
    html = html.replace(
      /<meta\s+property="og:description"\s+content="[^"]*"\s*\/>/,
      `<meta property="og:description" content="${d}" />`
    );

    // Twitter card tags — update if present, insert before </head> if not
    const twitterCard = `<meta name="twitter:card" content="summary" />`;
    const twitterTitle = `<meta name="twitter:title" content="${t}" />`;
    const twitterDesc = `<meta name="twitter:description" content="${d}" />`;

    if (html.includes('name="twitter:title"')) {
      html = html.replace(/<meta\s+name="twitter:title"\s+content="[^"]*"\s*\/>/, twitterTitle);
      html = html.replace(/<meta\s+name="twitter:description"\s+content="[^"]*"\s*\/>/, twitterDesc);
    } else {
      html = html.replace(
        "</head>",
        `  ${twitterCard}\n  ${twitterTitle}\n  ${twitterDesc}\n</head>`
      );
    }

    // Keywords — update if present, insert after og:description if not (and if keywords set)
    if (essay.seo_keywords && essay.seo_keywords.length > 0) {
      const kw = escapeHtmlAttr(essay.seo_keywords.join(", "));
      const keywordsMeta = `<meta name="keywords" content="${kw}" />`;
      if (html.includes('name="keywords"')) {
        html = html.replace(/<meta\s+name="keywords"\s+content="[^"]*"\s*\/>/, keywordsMeta);
      } else {
        html = html.replace(
          /(<meta\s+property="og:description"\s+content="[^"]*"\s*\/>)/,
          `$1\n  ${keywordsMeta}`
        );
      }
    } else if (html.includes('name="keywords"')) {
      // Clear keywords tag if seo_keywords was cleared
      html = html.replace(/<meta\s+name="keywords"\s+content="[^"]*"\s*\/>\n?/, "");
    }

    writeFileSync(htmlPath, html, "utf-8");
    console.log(`[seo] updated static head: ${htmlPath}`);
  } catch (err) {
    console.error(`[seo] failed to update static head for ${slug}:`, err);
  }
}

// ─── GET /api/admin/essays/:slug ─────────────────────────────────────────────

/**
 * GET /api/admin/essays/:slug
 *
 * Returns a single essay including content fields for the editor.
 *
 * Auth: X-Admin-Secret header.
 */
app.get("/api/admin/essays/:slug", requireAdminSecret, async (req: Request, res: Response) => {
  const { slug } = req.params;

  if (!supabase) {
    return res.status(503).json({ error: "Supabase not configured" });
  }

  const { data, error } = await supabase
    .from("essays")
    .select("slug, title, kicker, description, meta_description, seo_title, seo_description, seo_keywords, read_time, path, body_markdown, published_at, deployed_at, post_to_twitter, tweet_id, created_at, updated_at")
    .eq("slug", slug)
    .single();

  if (error) {
    console.error("[admin/essays] get single error:", error);
    return res.status(500).json({ error: "Failed to load essay" });
  }

  if (!data) {
    return res.status(404).json({ error: "Essay not found" });
  }

  res.json({ essay: data });
});

// ─── PATCH /api/admin/essays/:slug ───────────────────────────────────────────

/**
 * PATCH /api/admin/essays/:slug
 *
 * Update essay fields. Accepts:
 *   - published_at: string | null  → schedule/publish/draft (no version created)
 *   - body_markdown, title, meta_description, kicker, description, read_time
 *     → content update; current state is snapshotted into essay_versions first
 *   - change_summary: string | null  → optional label for the version
 *
 * Side effect when content changes: inserts a row into essay_versions.
 * Side effect when published_at changes: clears deployed_at for cron re-deploy.
 *
 * Auth: X-Admin-Secret header.
 */
app.patch("/api/admin/essays/:slug", requireAdminSecret, async (req: Request, res: Response) => {
  const { slug } = req.params;
  const body = req.body as {
    published_at?: string | null;
    body_markdown?: string;
    title?: string;
    meta_description?: string;
    kicker?: string;
    description?: string;
    read_time?: string;
    seo_title?: string | null;
    seo_description?: string | null;
    seo_keywords?: string[] | null;
    change_summary?: string | null;
    post_to_twitter?: boolean;
  };

  if (!supabase) {
    return res.status(503).json({ error: "Supabase not configured" });
  }

  if (body.published_at !== null && body.published_at !== undefined) {
    const d = new Date(body.published_at);
    if (isNaN(d.getTime())) {
      return res.status(400).json({ error: "Invalid published_at value" });
    }
  }

  const contentFields = ["body_markdown", "title", "meta_description", "kicker", "description", "read_time"] as const;
  const seoFields = ["seo_title", "seo_description", "seo_keywords"] as const;
  const socialFields = ["post_to_twitter"] as const;
  const isContentUpdate = contentFields.some((f) => body[f] !== undefined);
  const isSeoUpdate = seoFields.some((f) => body[f] !== undefined);

  // If content fields are changing, snapshot the current state into essay_versions first.
  if (isContentUpdate) {
    const { data: current, error: fetchError } = await supabase
      .from("essays")
      .select("title, body_markdown, meta_description")
      .eq("slug", slug)
      .single();

    if (fetchError) {
      console.error("[admin/essays] patch fetch-current error:", fetchError);
      return res.status(500).json({ error: "Failed to fetch current essay state" });
    }

    if (!current) {
      return res.status(404).json({ error: "Essay not found" });
    }

    const { error: versionError } = await supabase.from("essay_versions").insert({
      essay_slug: slug,
      title: current.title,
      body_markdown: current.body_markdown ?? null,
      meta_description: current.meta_description ?? null,
      changed_by: "admin",
      change_summary: body.change_summary ?? null,
    });

    if (versionError) {
      console.error("[admin/essays] patch version insert error:", versionError);
      return res.status(500).json({ error: "Failed to create version snapshot" });
    }
  }

  // Build the update payload.
  const update: Record<string, unknown> = {};
  if (body.published_at !== undefined) {
    update.published_at = body.published_at ?? null;
    update.deployed_at = null; // clear so cron re-deploys when published_at arrives
  }
  for (const f of contentFields) {
    if (body[f] !== undefined) update[f] = body[f];
  }
  for (const f of seoFields) {
    if (body[f] !== undefined) update[f] = body[f] ?? null;
  }
  for (const f of socialFields) {
    if (body[f] !== undefined) update[f] = body[f];
  }

  const { data, error } = await supabase
    .from("essays")
    .update(update)
    .eq("slug", slug)
    .select("slug, title, kicker, description, meta_description, seo_title, seo_description, seo_keywords, read_time, body_markdown, published_at, deployed_at, post_to_twitter, tweet_id")
    .single();

  if (error) {
    console.error("[admin/essays] patch error:", error);
    return res.status(500).json({ error: "Failed to update essay" });
  }

  if (!data) {
    return res.status(404).json({ error: "Essay not found" });
  }

  // Regenerate embedding in background when body_markdown changed
  if (body.body_markdown) {
    upsertEssayEmbedding(slug, body.body_markdown).catch((err) =>
      console.error("[admin/essays] embedding regen error:", err)
    );
  }

  // Update static essay HTML head tags when content or SEO fields change
  if (isContentUpdate || isSeoUpdate) {
    updateStaticEssayHead(slug, data);
  }

  res.json({ essay: data });
});

// ─── GET /api/admin/essays/:slug/versions ────────────────────────────────────

/**
 * GET /api/admin/essays/:slug/versions
 *
 * Returns paginated version list for an essay (20 per page).
 * Each entry includes: id, created_at, changed_by, change_summary, word_count.
 *
 * Query params:
 *   page  (default 1)
 *
 * Auth: X-Admin-Secret header.
 */
function countWords(text: string | null | undefined): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

app.get("/api/admin/essays/:slug/versions", requireAdminSecret, async (req: Request, res: Response) => {
  const { slug } = req.params;
  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const pageSize = 20;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  if (!supabase) {
    return res.status(503).json({ error: "Supabase not configured" });
  }

  const { data, error, count } = await supabase
    .from("essay_versions")
    .select("id, created_at, changed_by, change_summary, body_markdown", { count: "exact" })
    .eq("essay_slug", slug)
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) {
    console.error("[admin/essays] versions list error:", error);
    return res.status(500).json({ error: "Failed to load versions" });
  }

  const versions = (data ?? []).map((v) => ({
    id: v.id,
    created_at: v.created_at,
    changed_by: v.changed_by,
    change_summary: v.change_summary,
    word_count: countWords(v.body_markdown),
  }));

  res.json({ versions, total: count ?? 0, page, page_size: pageSize });
});

// ─── GET /api/admin/essays/:slug/versions/:versionId ─────────────────────────

/**
 * GET /api/admin/essays/:slug/versions/:versionId
 *
 * Returns full content of a specific version.
 *
 * Auth: X-Admin-Secret header.
 */
app.get("/api/admin/essays/:slug/versions/:versionId", requireAdminSecret, async (req: Request, res: Response) => {
  const { slug, versionId } = req.params;

  if (!supabase) {
    return res.status(503).json({ error: "Supabase not configured" });
  }

  const { data, error } = await supabase
    .from("essay_versions")
    .select("id, essay_slug, title, body_markdown, meta_description, changed_by, change_summary, created_at")
    .eq("essay_slug", slug)
    .eq("id", versionId)
    .single();

  if (error) {
    console.error("[admin/essays] version get error:", error);
    return res.status(500).json({ error: "Failed to load version" });
  }

  if (!data) {
    return res.status(404).json({ error: "Version not found" });
  }

  res.json({ version: data });
});

// ─── POST /api/admin/essays/:slug/versions/:versionId/revert ─────────────────

/**
 * POST /api/admin/essays/:slug/versions/:versionId/revert
 *
 * Reverts the live essay body to the content of the given version.
 * Creates a new version entry (snapshot of current state) before reverting,
 * with change_summary "Reverted to <original created_at>".
 * Does not delete any history.
 *
 * Auth: X-Admin-Secret header.
 */
app.post("/api/admin/essays/:slug/versions/:versionId/revert", requireAdminSecret, async (req: Request, res: Response) => {
  const { slug, versionId } = req.params;

  if (!supabase) {
    return res.status(503).json({ error: "Supabase not configured" });
  }

  // Load the target version
  const { data: targetVersion, error: tvError } = await supabase
    .from("essay_versions")
    .select("id, title, body_markdown, meta_description, created_at")
    .eq("essay_slug", slug)
    .eq("id", versionId)
    .single();

  if (tvError || !targetVersion) {
    return res.status(404).json({ error: "Version not found" });
  }

  // Snapshot current state before reverting
  const { data: current, error: fetchError } = await supabase
    .from("essays")
    .select("title, body_markdown, meta_description")
    .eq("slug", slug)
    .single();

  if (fetchError || !current) {
    return res.status(404).json({ error: "Essay not found" });
  }

  const revertSummary = `Reverted to ${new Date(targetVersion.created_at).toISOString()}`;

  const { error: snapError } = await supabase.from("essay_versions").insert({
    essay_slug: slug,
    title: current.title,
    body_markdown: current.body_markdown ?? null,
    meta_description: current.meta_description ?? null,
    changed_by: "admin",
    change_summary: revertSummary,
  });

  if (snapError) {
    console.error("[admin/essays] revert snapshot error:", snapError);
    return res.status(500).json({ error: "Failed to snapshot current state" });
  }

  // Apply the reverted content
  const { data: updated, error: updateError } = await supabase
    .from("essays")
    .update({
      title: targetVersion.title,
      body_markdown: targetVersion.body_markdown,
      meta_description: targetVersion.meta_description,
    })
    .eq("slug", slug)
    .select("slug, title, body_markdown, meta_description, seo_title, seo_description, seo_keywords, published_at")
    .single();

  if (updateError || !updated) {
    console.error("[admin/essays] revert update error:", updateError);
    return res.status(500).json({ error: "Failed to apply revert" });
  }

  // Update static HTML head after revert (title/body/meta changed)
  updateStaticEssayHead(slug, updated);

  res.json({ essay: updated, reverted_to: targetVersion.created_at });
});

// ─── POST /api/admin/essays/:slug/ping-search-engines ─────────────────────────

/**
 * POST /api/admin/essays/:slug/ping-search-engines
 *
 * Manually triggers a search engine ping for the given essay.
 * Notifies Google and Bing of the updated sitemap, and optionally calls
 * the Google Indexing API to request immediate re-crawl of the essay URL.
 *
 * Auth: X-Admin-Secret header.
 *
 * Response:
 *   { ok: true, pings: [{ engine, url, status_code }] }
 */
app.options("/api/admin/essays/:slug/ping-search-engines", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", SERVER_URL);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Secret");
  res.sendStatus(204);
});

app.post(
  "/api/admin/essays/:slug/ping-search-engines",
  requireAdminSecret,
  async (req: Request, res: Response) => {
    const { slug } = req.params;

    // Look up the essay path from Supabase
    const { data: essay, error } = await supabase
      .from("essays")
      .select("slug, path, deployed_at")
      .eq("slug", slug)
      .single();

    if (error || !essay) {
      res.status(404).json({ error: "Essay not found" });
      return;
    }

    if (!essay.deployed_at) {
      res.status(422).json({ error: "Essay has not been deployed yet — deploy before pinging" });
      return;
    }

    const SITE_URL = "https://paradoxofacceptance.xyz";
    const sitemapUrl = `${SITE_URL}/sitemap.xml`;
    const encodedSitemap = encodeURIComponent(sitemapUrl);
    const essayUrl = `${SITE_URL}${essay.path}`;

    type PingResult = { engine: string; url: string; status_code: number | null };
    const results: PingResult[] = [];

    async function pingGet(url: string): Promise<number | null> {
      try {
        const r = await fetch(url, { method: "GET" });
        return r.status;
      } catch {
        return null;
      }
    }

    // Google sitemap ping
    const googleUrl = `https://www.google.com/ping?sitemap=${encodedSitemap}`;
    results.push({ engine: "google", url: googleUrl, status_code: await pingGet(googleUrl) });

    // Bing sitemap ping
    const bingUrl = `https://www.bing.com/ping?sitemap=${encodedSitemap}`;
    results.push({ engine: "bing", url: bingUrl, status_code: await pingGet(bingUrl) });

    // Google Indexing API (optional)
    if (GOOGLE_SEARCH_CONSOLE_SITE_TOKEN) {
      let indexingStatus: number | null = null;
      try {
        const r = await fetch("https://indexing.googleapis.com/v3/urlNotifications:publish", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${GOOGLE_SEARCH_CONSOLE_SITE_TOKEN}`,
          },
          body: JSON.stringify({ url: essayUrl, type: "URL_UPDATED" }),
        });
        indexingStatus = r.status;
      } catch (err) {
        console.error("[ping-search-engines] Google Indexing API error:", err);
      }
      results.push({ engine: "google_indexing", url: essayUrl, status_code: indexingStatus });
    }

    // Log outcomes to sitemap_pings
    const now = new Date().toISOString();
    await supabase.from("sitemap_pings").insert(
      results.map((r) => ({ url: r.url, engine: r.engine, status_code: r.status_code, pinged_at: now })),
    );

    console.log(`[ping-search-engines] ${slug}:`, results.map((r) => `${r.engine}=${r.status_code}`).join(", "));

    res.json({ ok: true, pings: results });
  },
);

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
  const defaults = { weekly_digest: true, newsletter: true, course_updates: true, digest_channels: null as string[] | null };

  if (!supabase) {
    res.json({ email, preferences: defaults });
    return;
  }

  const { data, error } = await supabase
    .from("subscriber_preferences")
    .select("weekly_digest, newsletter, course_updates, digest_channels")
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
 * Body: { token, weekly_digest, newsletter, course_updates, digest_channels }
 * Upserts preferences for the subscriber identified by the JWT.
 * digest_channels: string[] of channel slugs to include in digest, or null for all.
 */
app.patch("/api/email/preferences", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!requirePreferencesSecret(res)) return;

  const { token, weekly_digest, newsletter, course_updates, digest_channels } = req.body as {
    token?: string;
    weekly_digest?: boolean;
    newsletter?: boolean;
    course_updates?: boolean;
    digest_channels?: string[] | null;
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

  const updates: Record<string, boolean | string[] | null> = {};
  if (typeof weekly_digest === "boolean") updates.weekly_digest = weekly_digest;
  if (typeof newsletter === "boolean") updates.newsletter = newsletter;
  if (typeof course_updates === "boolean") updates.course_updates = course_updates;
  if (digest_channels !== undefined) updates.digest_channels = digest_channels;

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

// ─── GET /api/channels ────────────────────────────────────────────────────────

// Known channels (seed data from OLU-409) — used as fallback when Supabase is unavailable
const KNOWN_CHANNELS = [
  { slug: "general", name: "General" },
  { slug: "meditation", name: "Meditation" },
  { slug: "breathwork", name: "Breathwork" },
  { slug: "philosophy", name: "Philosophy" },
  { slug: "daily-practice", name: "Daily Practice" },
  { slug: "resources", name: "Resources" },
  { slug: "introductions", name: "Introductions" },
];

app.options("/api/channels", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

/**
 * GET /api/channels
 *
 * Returns all community channels (slug, name). Used by the email preference
 * center to populate the Digest Topics channel checkboxes.
 * Falls back to KNOWN_CHANNELS if Supabase is unavailable.
 */
app.get("/api/channels", async (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!supabase) {
    return res.json({ channels: KNOWN_CHANNELS });
  }

  const { data, error } = await supabase
    .from("channels")
    .select("slug, name")
    .order("display_order", { ascending: true });

  if (error || !data || data.length === 0) {
    return res.json({ channels: KNOWN_CHANNELS });
  }

  return res.json({ channels: data });
});

// ─── GET /api/email/preferences/digest-preview ───────────────────────────────

app.options("/api/email/preferences/digest-preview", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

/**
 * GET /api/email/preferences/digest-preview?token={jwt}&channels=slug1,slug2
 *
 * Returns a rendered HTML preview of what the subscriber's next weekly digest
 * would look like based on the provided channel selection.
 *
 * channels: comma-separated channel slugs. If empty or omitted, shows all channels.
 */
app.get("/api/email/preferences/digest-preview", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!requirePreferencesSecret(res)) return;

  const { token, channels: channelsParam } = req.query as { token?: string; channels?: string };
  if (!token) {
    res.status(400).json({ error: "token is required" });
    return;
  }

  const result = verifyPreferencesToken(token);
  if (!result.ok) {
    res.status(401).json({ error: "Invalid or expired token", expired: result.expired });
    return;
  }

  const selectedSlugs = channelsParam
    ? channelsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const windowStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  let posts: Array<{ title: string; slug: string; excerpt: string | null; reply_count: number }> = [];

  if (supabase) {
    try {
      if (selectedSlugs.length === 0) {
        // All channels — no channel filter
        const { data } = await supabase
          .from("community_posts")
          .select("title, slug, excerpt, reply_count")
          .gte("created_at", windowStart)
          .eq("published", true)
          .order("reply_count", { ascending: false })
          .limit(3);
        posts = data ?? [];
      } else {
        // Resolve channel slugs to IDs, then filter posts
        const { data: channelRows } = await supabase
          .from("channels")
          .select("id, slug")
          .in("slug", selectedSlugs);

        const channelIds = (channelRows ?? []).map((c: { id: string }) => c.id);

        if (channelIds.length > 0) {
          const { data } = await supabase
            .from("community_posts")
            .select("title, slug, excerpt, reply_count")
            .gte("created_at", windowStart)
            .eq("published", true)
            .in("channel_id", channelIds)
            .order("reply_count", { ascending: false })
            .limit(3);
          posts = data ?? [];
        }
      }
    } catch {
      // Non-fatal — return empty preview
    }
  }

  const weekLabel = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const html = buildDigestPreviewHtml({ posts, weekLabel, selectedSlugs });
  return res.json({ html, postCount: posts.length });
});

function escapeHtmlStr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildDigestPreviewHtml({
  posts,
  weekLabel,
  selectedSlugs,
}: {
  posts: Array<{ title: string; slug: string; excerpt: string | null; reply_count: number }>;
  weekLabel: string;
  selectedSlugs: string[];
}): string {
  const SITE_URL = "https://paradoxofacceptance.xyz";

  const channelNote =
    selectedSlugs.length > 0
      ? `<p style="margin:0 0 24px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:#7d8c6e;background:#f0ede6;padding:10px 14px;border-radius:4px;">
          Preview filtered to: ${selectedSlugs.map(escapeHtmlStr).join(", ")}
        </p>`
      : "";

  const postsHtml =
    posts.length === 0
      ? `<p style="font-family:system-ui,-apple-system,sans-serif;font-size:15px;color:#888;font-style:italic;">
          No posts in the past 7 days for the selected channels.
        </p>`
      : posts
          .map(
            (post, i) => `
          <div style="margin-bottom:28px;padding-bottom:24px;${i < posts.length - 1 ? "border-bottom:1px solid #e8e4dc;" : ""}">
            <a href="${SITE_URL}/community/${escapeHtmlStr(post.slug)}"
               style="font-family:system-ui,-apple-system,sans-serif;font-size:17px;font-weight:600;color:#2c2c2c;text-decoration:none;">
              ${escapeHtmlStr(post.title)}
            </a>
            ${post.excerpt ? `<p style="margin:8px 0 0;font-size:16px;line-height:1.6;color:#555;">${escapeHtmlStr(post.excerpt)}</p>` : ""}
            <p style="margin:8px 0 0;font-size:14px;color:#888;">
              ${post.reply_count} ${post.reply_count === 1 ? "reply" : "replies"}
            </p>
          </div>`
          )
          .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Digest Preview</title>
</head>
<body style="margin:0;padding:0;background-color:#faf8f4;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#faf8f4;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" style="max-width:600px;" cellpadding="0" cellspacing="0">
        <tr>
          <td style="padding-bottom:24px;border-bottom:2px solid #7d8c6e;">
            <p style="margin:0 0 6px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#7d8c6e;">
              Paradox of Acceptance
            </p>
            <h1 style="margin:0 0 4px;font-family:Georgia,serif;font-size:22px;font-weight:normal;color:#2c2c2c;">
              This Week in the Community
            </h1>
            <p style="margin:0;font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:#888;">
              ${escapeHtmlStr(weekLabel)}
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding-top:28px;">
            ${channelNote}
            <h2 style="font-family:system-ui,-apple-system,sans-serif;font-size:16px;font-weight:600;color:#2c2c2c;margin:0 0 16px;padding-bottom:10px;border-bottom:2px solid #7d8c6e;">
              Top Discussions
            </h2>
            ${postsHtml}
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

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

  // Suppression check: bounced addresses are undeliverable; skip silently
  const { suppressed, status: subStatus } = await isSuppressed(email);
  if (suppressed) {
    console.log(`[preferences/send-link] Skipping ${email} — suppressed (status=${subStatus})`);
    await logEmailSend(email, "preferences_link", "skipped", { skipReason: subStatus ?? undefined });
    // Return 200 — don't reveal suppression status to the caller
    res.json({ ok: true });
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

  const { data: sendData, error } = await resend.emails.send({
    from: EMAIL_FROM!,
    to: email.toLowerCase().trim(),
    replyTo: EMAIL_REPLY_TO || undefined,
    subject: "Your email preferences link",
    html,
  });

  if (error) {
    console.error("[preferences/send-link] Failed to send:", error);
    await logEmailSend(email, "preferences_link", "failed");
    res.status(500).json({ error: "Failed to send preferences link" });
    return;
  }

  console.log(`[preferences/send-link] Sent to ${email}`);
  await logEmailSend(email, "preferences_link", "sent", { resendEmailId: sendData?.id });
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
const TRACKED_EVENT_TYPES = new Set([
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.complained",
  "email.unsubscribed",
]);

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
  const recipientEmail = (Array.isArray(toField) ? String(toField[0]) : (toField ? String(toField) : null))?.toLowerCase().trim() ?? null;
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

  // ── Side-effects: update subscriber status based on event type ──────────────
  if (recipientEmail) {
    if (eventType === "email.bounced") {
      // Only suppress on hard bounces — soft bounces are transient
      const bounce = data.bounce as Record<string, unknown> | undefined;
      const bounceType = String(bounce?.type ?? data.bounce_type ?? "hard").toLowerCase();
      if (bounceType === "hard") {
        await supabase
          .from("subscribers")
          .update({ status: "bounced" })
          .eq("email", recipientEmail)
          .neq("status", "bounced");
        console.log(`[webhook/resend] Hard bounce — suppressed ${recipientEmail}`);
      } else {
        console.log(`[webhook/resend] Soft bounce for ${recipientEmail} — not suppressed`);
      }
    } else if (eventType === "email.unsubscribed") {
      // Resend has already marked the contact unsubscribed; mirror in Supabase
      await supabase
        .from("subscribers")
        .update({ status: "unsubscribed" })
        .eq("email", recipientEmail)
        .not("status", "in", '("bounced","unsubscribed")');
      console.log(`[webhook/resend] Unsubscribed — suppressed ${recipientEmail}`);
    } else if (eventType === "email.complained") {
      // Spam complaint: suppress immediately and insert to complaints table
      await supabase
        .from("subscribers")
        .update({ status: "unsubscribed" })
        .eq("email", recipientEmail)
        .not("status", "in", '("bounced","unsubscribed")');
      // Non-fatal insert to complaints for tracking complaint rate
      await supabase.from("complaints").insert({
        email: recipientEmail,
        complained_at: occurredAt,
        message_id: emailId,
      }).then(({ error: cErr }) => {
        if (cErr) console.warn(`[webhook/resend] Could not insert complaint record for ${recipientEmail}: ${cErr.message}`);
      });
      console.log(`[webhook/resend] Spam complaint — suppressed ${recipientEmail} and flagged for review`);
    }
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
  const scrollPct = typeof req.body?.scroll_percent === "number"
    ? Math.min(Math.max(Math.round(req.body.scroll_percent), 0), 100)
    : null;

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
        ...(scrollPct !== null ? { scroll_percent: scrollPct } : {}),
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
        ...(scrollPct !== null ? { scroll_percent: scrollPct } : {}),
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

// ─── Reading History ──────────────────────────────────────────────────────────
//
// GET /api/reading-history/me
// Returns per-essay reading history with metadata for the /account/history page.
// Auth required.

app.options("/api/reading-history/me", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.sendStatus(204);
});

app.get("/api/reading-history/me", async (req: Request, res: Response) => {
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

  // All reads for this user, newest first
  const { data: reads, error: readsError } = await supabase
    .from("essay_reads")
    .select("essay_slug, read_at, read_duration_seconds, scroll_percent")
    .eq("user_id", userId)
    .order("read_at", { ascending: false });

  if (readsError) {
    res.status(500).json({ error: "Failed to fetch reading history" });
    return;
  }

  // Essay metadata (service role bypasses RLS on essays table)
  const { data: essays } = await supabase
    .from("essays")
    .select("slug, title, read_time, path")
    .not("published_at", "is", null);

  const essayMap = new Map<string, { title: string; read_time: string | null; path: string }>();
  for (const e of (essays ?? []) as Array<{ slug: string; title: string; read_time: string | null; path: string }>) {
    essayMap.set(e.slug, e);
  }

  // Deduplicate to one row per essay (latest read wins)
  const seen = new Set<string>();
  type HistoryRow = {
    slug: string;
    title: string;
    path: string;
    estimated_read_time: string | null;
    last_read_at: string;
    read_duration_seconds: number;
    scroll_percent: number | null;
  };
  const history: HistoryRow[] = [];

  for (const row of (reads ?? []) as Array<{ essay_slug: string; read_at: string; read_duration_seconds: number; scroll_percent: number | null }>) {
    if (seen.has(row.essay_slug)) continue;
    seen.add(row.essay_slug);
    const meta = essayMap.get(row.essay_slug);
    history.push({
      slug: row.essay_slug,
      title: meta?.title ?? row.essay_slug,
      path: meta?.path ?? `/mindfulness-essays/${row.essay_slug}/`,
      estimated_read_time: meta?.read_time ?? null,
      last_read_at: row.read_at,
      read_duration_seconds: row.read_duration_seconds,
      scroll_percent: row.scroll_percent,
    });
  }

  // Streak
  const { data: streakRow } = await supabase
    .from("reading_streaks")
    .select("current_streak, longest_streak, last_read_date")
    .eq("user_id", userId)
    .maybeSingle();

  // Total reading time this month (all reads, not just deduplicated)
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const { data: monthReads } = await supabase
    .from("essay_reads")
    .select("read_duration_seconds")
    .eq("user_id", userId)
    .gte("read_at", monthStart);

  const totalSecondsThisMonth = ((monthReads ?? []) as Array<{ read_duration_seconds: number }>)
    .reduce((sum, r) => sum + r.read_duration_seconds, 0);

  res.json({
    history,
    stats: {
      total_essays_read: history.length,
      total_seconds_this_month: totalSecondsThisMonth,
      current_streak: (streakRow as { current_streak: number } | null)?.current_streak ?? 0,
    },
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

// ─── GET /api/essays ─────────────────────────────────────────────────────────

/**
 * GET /api/essays
 *
 * Public. Returns all essays with word_count and reading_time_minutes.
 * Used by static pages to render accurate reading time labels.
 */
app.options("/api/essays", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

app.get("/api/essays", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const essays = Object.entries(ESSAY_META).map(([slug, meta]) => ({
    slug,
    title: meta.title,
    description: meta.description,
    path: meta.path,
    word_count: meta.word_count,
    reading_time_minutes: meta.reading_time_minutes,
  }));
  res.json({ essays });
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
// word_count: counted from <article> body text (whitespace-split). reading_time_minutes: ceil(word_count / 200).
const ESSAY_META: Record<string, { title: string; description: string; path: string; word_count: number; reading_time_minutes: number }> = {
  "paradox-of-acceptance": {
    title: "The Paradox of Acceptance",
    description: "A meditation on what happens to ambition, urgency, and deferred gratification when mindfulness becomes very good.",
    path: "/mindfulness-essays/paradox-of-acceptance/",
    word_count: 3444,
    reading_time_minutes: 18,
  },
  "should-you-get-into-mindfulness": {
    title: "Should You Get Into Mindfulness?",
    description: "An honest look at who benefits from mindfulness practice and who might be better served elsewhere.",
    path: "/mindfulness-essays/should-you-get-into-mindfulness/",
    word_count: 1273,
    reading_time_minutes: 7,
  },
  "the-avoidance-problem": {
    title: "The Avoidance Problem",
    description: "On using mindfulness to avoid rather than engage — and how to tell the difference.",
    path: "/mindfulness-essays/the-avoidance-problem/",
    word_count: 1677,
    reading_time_minutes: 9,
  },
  "the-cherry-picking-problem": {
    title: "The Cherry-Picking Problem",
    description: "Why we select the comfortable parts of mindfulness and leave the harder teachings untouched.",
    path: "/mindfulness-essays/the-cherry-picking-problem/",
    word_count: 1252,
    reading_time_minutes: 7,
  },
  "when-to-quit": {
    title: "When to Quit",
    description: "How mindfulness changes the calculus around persistence, quitting, and what counts as giving up.",
    path: "/mindfulness-essays/when-to-quit/",
    word_count: 1656,
    reading_time_minutes: 9,
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
      estimated_read_minutes: slugs.reduce((sum, slug) => sum + (ESSAY_META[slug]?.reading_time_minutes ?? 7), 0),
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
      estimated_read_minutes: essays.reduce((sum, e) => sum + (ESSAY_META[e.slug]?.reading_time_minutes ?? 7), 0),
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

// ─── GET /api/admin/email/health ──────────────────────────────────────────────

/**
 * GET /api/admin/email/health
 *
 * Returns sender reputation metrics derived from the subscribers and complaints tables.
 * Fires a Sentry alert if bounce_rate > 5% or complaint_rate > 0.1%.
 *
 * Response:
 *   total          — all subscriber rows
 *   active         — status = 'active'
 *   bounced        — status = 'bounced'
 *   unsubscribed   — status = 'unsubscribed'
 *   suppressed     — bounced + unsubscribed
 *   complained     — total rows in complaints table
 *   bounce_rate    — bounced / total  (0–1)
 *   complaint_rate — complained / total (0–1)
 *   alerts         — { bounce: 'ok'|'warning'|'danger', complaint: 'ok'|'warning'|'danger' }
 *
 * Auth: X-Admin-Secret header.
 */
app.get("/api/admin/email/health", requireAdminSecret, async (_req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }

  // Fetch status counts from subscribers
  const { data: rows, error: subErr } = await supabase
    .from("subscribers")
    .select("status");

  if (subErr) {
    res.status(500).json({ error: "Failed to query subscribers", detail: subErr.message });
    return;
  }

  const counts: Record<string, number> = { active: 0, bounced: 0, unsubscribed: 0, pruned: 0 };
  for (const row of rows ?? []) {
    const s = row.status as string;
    counts[s] = (counts[s] ?? 0) + 1;
  }

  const total = rows?.length ?? 0;
  const active = counts["active"] ?? 0;
  const bounced = counts["bounced"] ?? 0;
  const unsubscribed = counts["unsubscribed"] ?? 0;
  const suppressed = bounced + unsubscribed;

  // Fetch complaint count from complaints table
  const { count: complainedCount, error: compErr } = await supabase
    .from("complaints")
    .select("id", { count: "exact", head: true });

  if (compErr) {
    console.warn("[email/health] Failed to query complaints table:", compErr.message);
  }
  const complained = complainedCount ?? 0;

  const bounce_rate = total > 0 ? bounced / total : 0;
  const complaint_rate = total > 0 ? complained / total : 0;

  // Threshold alerts
  const bounce_alert = bounce_rate > 0.05 ? "danger" : bounce_rate > 0.02 ? "warning" : "ok";
  const complaint_alert = complaint_rate > 0.001 ? "danger" : complaint_rate > 0.0005 ? "warning" : "ok";

  // Fire Sentry alert if industry danger thresholds exceeded
  if (bounce_rate > 0.05 || complaint_rate > 0.001) {
    await captureSentryAlert(
      `Email health alert: bounce_rate=${(bounce_rate * 100).toFixed(2)}% complaint_rate=${(complaint_rate * 100).toFixed(3)}%`,
      "warning",
      { total, active, bounced, unsubscribed, suppressed, complained, bounce_rate, complaint_rate }
    );
  }

  res.json({
    total,
    active,
    bounced,
    unsubscribed,
    suppressed,
    complained,
    bounce_rate,
    complaint_rate,
    alerts: { bounce: bounce_alert, complaint: complaint_alert },
  });
});

// ─── GET /api/admin/email/suppression-csv ─────────────────────────────────────

/**
 * GET /api/admin/email/suppression-csv
 *
 * Returns a CSV download of all suppressed addresses (bounced + unsubscribed).
 * Columns: email, status, updated_at
 *
 * Auth: X-Admin-Secret header.
 */
app.get("/api/admin/email/suppression-csv", requireAdminSecret, async (_req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }

  const { data, error } = await supabase
    .from("subscribers")
    .select("email, status, updated_at")
    .in("status", ["bounced", "unsubscribed"])
    .order("updated_at", { ascending: false });

  if (error) {
    res.status(500).json({ error: "Failed to query suppression list", detail: error.message });
    return;
  }

  const rows = data ?? [];
  const lines = ["email,status,updated_at"];
  for (const row of rows) {
    const email = `"${String(row.email).replace(/"/g, '""')}"`;
    const status = `"${String(row.status).replace(/"/g, '""')}"`;
    const updatedAt = `"${String(row.updated_at ?? "").replace(/"/g, '""')}"`;
    lines.push(`${email},${status},${updatedAt}`);
  }

  const csv = lines.join("\n");
  const filename = `suppression-list-${new Date().toISOString().slice(0, 10)}.csv`;

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

// ─── POST /api/admin/email/import-csv ────────────────────────────────────────

/**
 * POST /api/admin/email/import-csv
 *
 * Multipart form upload — field name "file" must be a CSV.
 * Optional query params: email_col, first_name_col, last_name_col
 *   (auto-detected from headers when omitted)
 *
 * Returns immediately with { jobId, total } — use the status endpoint to poll.
 *
 * Auth: X-Admin-Secret header.
 */
app.post(
  "/api/admin/email/import-csv",
  requireAdminSecret,
  csvUpload.single("file"),
  async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded — send multipart/form-data with field 'file'" });
      return;
    }

    if (!RESEND_API_KEY || !RESEND_AUDIENCE_ID) {
      res.status(503).json({ error: "RESEND_API_KEY / RESEND_AUDIENCE_ID not configured" });
      return;
    }

    const csvText = req.file.buffer.toString("utf-8");

    // Parse CSV
    const parsed = Papa.parse<Record<string, string>>(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h) => h.trim(),
    });

    const headers = parsed.meta.fields ?? [];
    if (headers.length === 0) {
      res.status(400).json({ error: "CSV appears to have no headers" });
      return;
    }

    // Resolve columns
    const emailCol =
      (req.query.email_col as string | undefined) ??
      findEmailColumn(headers);

    if (!emailCol || !headers.includes(emailCol)) {
      res.status(400).json({
        error: "CSV must contain an email column (email / Email / EMAIL / e-mail)",
        headers,
      });
      return;
    }

    const firstNameCol =
      (req.query.first_name_col as string | undefined) ??
      headers.find((h) => /^first.?name$/i.test(h));

    const lastNameCol =
      (req.query.last_name_col as string | undefined) ??
      headers.find((h) => /^last.?name$/i.test(h));

    const rows = parsed.data;
    const jobId = randomUUID();
    const job: ImportJob = {
      id: jobId,
      status: "running",
      total: rows.length,
      processed: 0,
      imported: 0,
      skipped_duplicates: 0,
      failed: 0,
      createdAt: new Date().toISOString(),
    };
    importJobs.set(jobId, job);

    // Start background processing — respond immediately
    runCsvImport(jobId, rows, emailCol, firstNameCol, lastNameCol).catch((err) => {
      const j = importJobs.get(jobId);
      if (j) {
        j.status = "failed";
        j.error = String(err?.message ?? err);
        j.completedAt = new Date().toISOString();
      }
      console.error(`[import-csv] Job ${jobId} failed:`, err);
    });

    res.json({ jobId, total: rows.length });
  }
);

// ─── GET /api/admin/email/import-csv/status/:jobId ────────────────────────────

/**
 * GET /api/admin/email/import-csv/status/:jobId
 *
 * Returns current state of a bulk import job.
 * Auth: X-Admin-Secret header.
 */
app.get("/api/admin/email/import-csv/status/:jobId", requireAdminSecret, (req: Request, res: Response) => {
  const job = importJobs.get(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found — jobs are only kept in memory for the server lifetime" });
    return;
  }
  res.json(job);
});

// ─── About Page API ───────────────────────────────────────────────────────────
//
// GET  /api/about            — public; returns about page content
// PATCH /api/admin/about     — admin; update about page content (+ optional photo)

const aboutPhotoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are accepted"));
    }
  },
});

// CORS pre-flight for public about endpoint (called from static page)
app.options("/api/about", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

/**
 * GET /api/about
 *
 * Public. Returns the current about page content from Supabase.
 * Returns an empty object with default fields if no row exists yet.
 */
app.get("/api/about", async (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (!supabase) {
    return res.json({ about: null });
  }
  const { data, error } = await supabase
    .from("about_page")
    .select("photo_url, tagline, bio_markdown, twitter_url, linkedin_url, contact_email, updated_at")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[api/about] Supabase error:", error);
    return res.status(500).json({ error: "Failed to load about page" });
  }
  res.json({ about: data ?? null });
});

/**
 * PATCH /api/admin/about
 *
 * Admin. Updates the about page content. Accepts multipart/form-data so an
 * optional photo can be included. Non-photo fields are plain text form fields.
 *
 * Form fields (all optional):
 *   photo       — image file (JPEG/PNG/WebP)
 *   tagline     — one-line tagline
 *   bio_markdown — full bio in Markdown
 *   twitter_url  — Twitter/X profile URL
 *   linkedin_url — LinkedIn profile URL
 *   contact_email — public contact email
 *
 * Auth: X-Admin-Secret header.
 */
app.options("/api/admin/about", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Secret");
  res.sendStatus(204);
});

app.patch(
  "/api/admin/about",
  requireAdminSecret,
  aboutPhotoUpload.single("photo"),
  async (req: Request, res: Response) => {
    if (!supabase) {
      return res.status(503).json({ error: "Supabase not configured" });
    }

    const { tagline, bio_markdown, twitter_url, linkedin_url, contact_email } = req.body as {
      tagline?: string;
      bio_markdown?: string;
      twitter_url?: string;
      linkedin_url?: string;
      contact_email?: string;
    };

    // Handle optional photo upload to Supabase Storage
    let photo_url: string | undefined;
    if (req.file) {
      const ext = req.file.originalname.split(".").pop() ?? "jpg";
      const filePath = `profile.${ext}`;
      const { error: uploadError } = await supabase.storage
        .from("about")
        .upload(filePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: true,
        });
      if (uploadError) {
        console.error("[admin/about] Storage upload error:", uploadError);
        return res.status(500).json({ error: "Photo upload failed" });
      }
      const { data: urlData } = supabase.storage.from("about").getPublicUrl(filePath);
      photo_url = urlData.publicUrl;
    }

    // Fetch existing row to upsert correctly
    const { data: existing } = await supabase
      .from("about_page")
      .select("id")
      .limit(1)
      .maybeSingle();

    const payload: Record<string, unknown> = {};
    if (tagline !== undefined) payload.tagline = tagline;
    if (bio_markdown !== undefined) payload.bio_markdown = bio_markdown;
    if (twitter_url !== undefined) payload.twitter_url = twitter_url || null;
    if (linkedin_url !== undefined) payload.linkedin_url = linkedin_url || null;
    if (contact_email !== undefined) payload.contact_email = contact_email || null;
    if (photo_url !== undefined) payload.photo_url = photo_url;

    let result;
    if (existing?.id) {
      result = await supabase
        .from("about_page")
        .update(payload)
        .eq("id", existing.id)
        .select("photo_url, tagline, bio_markdown, twitter_url, linkedin_url, contact_email, updated_at")
        .single();
    } else {
      result = await supabase
        .from("about_page")
        .insert(payload)
        .select("photo_url, tagline, bio_markdown, twitter_url, linkedin_url, contact_email, updated_at")
        .single();
    }

    if (result.error) {
      console.error("[admin/about] Supabase error:", result.error);
      return res.status(500).json({ error: "Failed to save about page" });
    }

    res.json({ about: result.data });
  }
);

// ─── POST /api/social/tweet ───────────────────────────────────────────────────

/**
 * POST /api/social/tweet
 *
 * Manually post (or re-post) a tweet for an essay.
 * Useful for retrying after a failed auto-post or for one-off shares.
 *
 * Body: { slug: string }
 *
 * On success: stores tweet_id on the essay record and returns { tweetId, text }.
 * On failure: logs to social_post_errors and returns 500.
 *
 * Requires Twitter API credentials in env (TWITTER_API_KEY etc.).
 * Auth: X-Admin-Secret header.
 */

/** Build tweet text from an essay. Max 280 chars. */
function buildTweetText(essay: {
  title: string;
  description: string | null;
  path: string;
  seo_keywords: string[] | null;
}): string {
  const url = `${SITE_URL_SOCIAL}${essay.path}`;
  const desc = (essay.description ?? "").trim();
  const sentenceEnd = desc.search(/[.!?](\s|$)/);
  const firstSentence = sentenceEnd >= 0 ? desc.slice(0, sentenceEnd + 1).trim() : desc;
  const hashtags = (essay.seo_keywords ?? [])
    .slice(0, 3)
    .map((kw) => "#" + kw.replace(/\s+/g, "").replace(/[^a-zA-Z0-9_]/g, ""))
    .filter((h) => h.length > 1)
    .join(" ");
  const suffix = "\n\n" + url + (hashtags ? "\n\n" + hashtags : "");
  let tweet = essay.title + (firstSentence ? "\n\n" + firstSentence : "") + suffix;
  if (tweet.length <= 280) return tweet;
  const base = essay.title + "\n\n";
  const maxExcerpt = 280 - base.length - suffix.length - 1;
  if (firstSentence && maxExcerpt > 0) {
    const candidate = base + firstSentence.slice(0, maxExcerpt) + "…" + suffix;
    if (candidate.length <= 280) return candidate;
  }
  tweet = essay.title + suffix;
  if (tweet.length <= 280) return tweet;
  return essay.title.slice(0, 280 - url.length - 2) + "\n\n" + url;
}

/** Post a tweet via Twitter API v2 (OAuth 1.0a user context). */
async function postTweetV2(text: string): Promise<{ id: string; text: string }> {
  if (!TWITTER_API_KEY || !TWITTER_API_SECRET || !TWITTER_ACCESS_TOKEN || !TWITTER_ACCESS_SECRET) {
    throw new Error("Twitter API credentials not configured");
  }
  const tweetUrl = "https://api.twitter.com/2/tweets";
  const method = "POST";
  const { randomBytes: rb } = await import("crypto");
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: TWITTER_API_KEY,
    oauth_nonce: rb(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: TWITTER_ACCESS_TOKEN,
    oauth_version: "1.0",
  };
  const paramStr = Object.entries(oauthParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const sigBase = [method, encodeURIComponent(tweetUrl), encodeURIComponent(paramStr)].join("&");
  const sigKey = `${encodeURIComponent(TWITTER_API_SECRET)}&${encodeURIComponent(TWITTER_ACCESS_SECRET)}`;
  const { createHmac: ch } = await import("crypto");
  const signature = ch("sha1", sigKey).update(sigBase).digest("base64");
  const authHeader =
    "OAuth " +
    [
      ...Object.entries(oauthParams).map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`),
      `oauth_signature="${encodeURIComponent(signature)}"`,
    ].join(", ");
  const res = await fetch(tweetUrl, {
    method,
    headers: { Authorization: authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Twitter API ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { data: { id: string; text: string } };
  return data.data;
}

app.post("/api/social/tweet", requireAdminSecret, async (req: Request, res: Response) => {
  if (!supabase) {
    return res.status(503).json({ error: "Supabase not configured" });
  }

  const { slug } = req.body as { slug?: string };
  if (!slug) {
    return res.status(400).json({ error: "slug is required" });
  }

  const { data: essay, error: fetchErr } = await supabase
    .from("essays")
    .select("slug, title, description, path, seo_keywords, tweet_id")
    .eq("slug", slug)
    .single();

  if (fetchErr || !essay) {
    return res.status(404).json({ error: "Essay not found" });
  }

  try {
    const tweetText = buildTweetText(essay);
    const { id: tweetId, text: tweetText2 } = await postTweetV2(tweetText);

    const { error: updateErr } = await supabase
      .from("essays")
      .update({ tweet_id: tweetId })
      .eq("slug", slug);

    if (updateErr) {
      console.error("[social/tweet] Failed to store tweet_id:", updateErr);
    }

    return res.json({ tweetId, text: tweetText2 });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[social/tweet] Error:", errMsg);

    if (supabase) {
      await supabase.from("social_post_errors").insert({
        essay_slug: slug,
        platform: "twitter",
        error_msg: errMsg,
      });
    }

    return res.status(500).json({ error: errMsg });
  }
});

// ─── Guest Essay Submissions ──────────────────────────────────────────────────

/**
 * POST /api/submissions
 *
 * Public — allows readers to submit essay drafts for consideration.
 *
 * Body: { name, email, title, content (markdown), bio? }
 *
 * - Rate limited to 1 submission per email per 7 days (checked via Supabase).
 * - Saves to essay_submissions table with status "pending".
 * - Sends confirmation email to submitter (gated on RESEND_API_KEY).
 * - Notifies ADMIN_NOTIFY_EMAIL of new submission (gated on RESEND_API_KEY + ADMIN_NOTIFY_EMAIL).
 */
app.options("/api/submissions", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

app.post("/api/submissions", async (req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }

  const { name, email, title, content, bio } = req.body as {
    name?: string;
    email?: string;
    title?: string;
    content?: string;
    bio?: string;
  };

  // Validate required fields
  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (!email || typeof email !== "string" || !email.includes("@")) {
    res.status(400).json({ error: "A valid email is required" });
    return;
  }
  if (!title || typeof title !== "string" || !title.trim()) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  if (!content || typeof content !== "string" || content.trim().length < 100) {
    res.status(400).json({ error: "content is required and must be at least 100 characters" });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Rate limit: 1 submission per email per 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentSubmission, error: rateCheckError } = await supabase
    .from("essay_submissions")
    .select("id, submitted_at")
    .eq("email", normalizedEmail)
    .gte("submitted_at", sevenDaysAgo)
    .maybeSingle();

  if (rateCheckError) {
    console.error("[submissions] rate-limit check error:", rateCheckError);
    res.status(500).json({ error: "Submission failed — please try again later" });
    return;
  }

  if (recentSubmission) {
    res.status(429).json({
      error: "You have already submitted an essay in the past 7 days. Please wait before submitting again.",
    });
    return;
  }

  // Insert submission
  const { data: submission, error: insertError } = await supabase
    .from("essay_submissions")
    .insert({
      name: name.trim(),
      email: normalizedEmail,
      title: title.trim(),
      content: content.trim(),
      bio: bio?.trim() ?? null,
      status: "pending",
    })
    .select("id, submitted_at")
    .single();

  if (insertError) {
    console.error("[submissions] insert error:", insertError);
    res.status(500).json({ error: "Submission failed — please try again later" });
    return;
  }

  console.log(`[submissions] New submission from ${normalizedEmail}: "${title.trim()}" (id: ${submission.id})`);

  // Send emails non-blocking
  if (RESEND_API_KEY && EMAIL_FROM) {
    const resend = new Resend(RESEND_API_KEY);

    // Confirmation email to submitter
    resend.emails.send({
      from: EMAIL_FROM,
      to: normalizedEmail,
      subject: "We received your essay submission",
      html: `
        <p>Hi ${name.trim()},</p>
        <p>Thanks for submitting <strong>${title.trim()}</strong> to Paradox of Acceptance.</p>
        <p>We review all submissions personally and will get back to you if it's a good fit. This can take a few weeks.</p>
        <p>— Nick</p>
      `.trim(),
    }).catch((err: unknown) => {
      console.error(`[submissions] confirmation email error for ${normalizedEmail}:`, err);
    });

    // Admin notification email to Nick
    if (ADMIN_NOTIFY_EMAIL) {
      resend.emails.send({
        from: EMAIL_FROM,
        to: ADMIN_NOTIFY_EMAIL,
        subject: `New essay submission: "${title.trim()}"`,
        html: `
          <p>A new essay has been submitted for review.</p>
          <ul>
            <li><strong>Name:</strong> ${name.trim()}</li>
            <li><strong>Email:</strong> ${normalizedEmail}</li>
            <li><strong>Title:</strong> ${title.trim()}</li>
            ${bio ? `<li><strong>Bio:</strong> ${bio.trim()}</li>` : ""}
            <li><strong>Submission ID:</strong> ${submission.id}</li>
          </ul>
          <p><strong>Content preview:</strong></p>
          <pre style="white-space:pre-wrap;font-family:inherit">${content.trim().slice(0, 500)}${content.trim().length > 500 ? "…" : ""}</pre>
        `.trim(),
      }).catch((err: unknown) => {
        console.error(`[submissions] admin notification email error:`, err);
      });
    }
  }

  res.status(201).json({ status: "received", id: submission.id });
});

// ─── GET /api/admin/submissions ───────────────────────────────────────────────

/**
 * GET /api/admin/submissions?status=pending
 *
 * Admin — list all submissions, optionally filtered by status.
 * Status values: pending | reviewed | accepted | rejected
 */
app.get("/api/admin/submissions", requireAdminSecret, async (req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }

  const { status } = req.query as { status?: string };
  const validStatuses = ["pending", "reviewed", "accepted", "rejected"];

  let query = supabase
    .from("essay_submissions")
    .select("id, name, email, title, bio, status, admin_notes, submitted_at, updated_at")
    .order("submitted_at", { ascending: false });

  if (status) {
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
      return;
    }
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) {
    console.error("[admin/submissions] list error:", error);
    res.status(500).json({ error: "Failed to fetch submissions" });
    return;
  }

  res.json({ submissions: data ?? [] });
});

// ─── PATCH /api/admin/submissions/:id ─────────────────────────────────────────

/**
 * PATCH /api/admin/submissions/:id
 *
 * Admin — update submission status and/or admin notes.
 * Body: { status?, admin_notes? }
 */
app.patch("/api/admin/submissions/:id", requireAdminSecret, async (req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }

  const { id } = req.params;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    res.status(400).json({ error: "Invalid submission id" });
    return;
  }

  const { status, admin_notes } = req.body as { status?: string; admin_notes?: string };
  const validStatuses = ["pending", "reviewed", "accepted", "rejected"];

  if (status !== undefined && !validStatuses.includes(status)) {
    res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
    return;
  }

  const updates: Record<string, unknown> = {};
  if (status !== undefined) updates.status = status;
  if (admin_notes !== undefined) updates.admin_notes = admin_notes;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update. Provide status and/or admin_notes." });
    return;
  }

  const { data, error } = await supabase
    .from("essay_submissions")
    .update(updates)
    .eq("id", id)
    .select("id, name, email, title, bio, status, admin_notes, submitted_at, updated_at")
    .maybeSingle();

  if (error) {
    console.error("[admin/submissions] update error:", error);
    res.status(500).json({ error: "Failed to update submission" });
    return;
  }

  if (!data) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }

  res.json({ submission: data });
});

// ─── POST /api/admin/submissions/:id/promote ──────────────────────────────────

/**
 * POST /api/admin/submissions/:id/promote
 *
 * Admin — promote an accepted submission to a draft essay.
 * Copies title + content to the essays table with status draft (published_at = null).
 * The submission status is set to "accepted" if not already.
 * Returns the new essay row.
 */
app.post("/api/admin/submissions/:id/promote", requireAdminSecret, async (req: Request, res: Response) => {
  if (!supabase) {
    res.status(503).json({ error: "Supabase not configured" });
    return;
  }

  const { id } = req.params;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    res.status(400).json({ error: "Invalid submission id" });
    return;
  }

  // Fetch the submission
  const { data: submission, error: fetchError } = await supabase
    .from("essay_submissions")
    .select("id, name, email, title, content, bio, status")
    .eq("id", id)
    .maybeSingle();

  if (fetchError) {
    console.error("[admin/submissions/promote] fetch error:", fetchError);
    res.status(500).json({ error: "Failed to fetch submission" });
    return;
  }

  if (!submission) {
    res.status(404).json({ error: "Submission not found" });
    return;
  }

  // Build a slug from the title
  const slug = submission.title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 80);

  if (!slug) {
    res.status(400).json({ error: "Could not generate a valid slug from the submission title" });
    return;
  }

  const path = `/mindfulness-essays/${slug}/`;

  // Insert draft essay (published_at = null → draft)
  const { data: essay, error: insertError } = await supabase
    .from("essays")
    .insert({
      slug,
      title: submission.title,
      kicker: null,
      description: submission.bio ?? null,
      read_time: null,
      path,
      published_at: null,
    })
    .select("id, slug, title, kicker, description, path, published_at, created_at")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      res.status(409).json({ error: `An essay with slug "${slug}" already exists` });
      return;
    }
    console.error("[admin/submissions/promote] insert essay error:", insertError);
    res.status(500).json({ error: "Failed to promote submission to essay" });
    return;
  }

  // Mark submission as accepted
  await supabase
    .from("essay_submissions")
    .update({ status: "accepted" })
    .eq("id", id);

  console.log(`[admin/submissions/promote] Submission ${id} promoted to essay slug="${slug}"`);

  res.status(201).json({ essay, submissionId: id });
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
