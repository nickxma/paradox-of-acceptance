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
 *   POST /send        — send newsletter (test or full list)
 *   GET  /health      — health check
 *   GET  /status/:id  — check broadcast status
 *
 * Auth: X-Api-Key header required on all /send endpoints.
 *
 * IMPORTANT: Full-list sends are blocked unless ALLOW_FULL_LIST_SEND=true.
 *            Nick must explicitly approve before setting this.
 */

import express, { Request, Response, NextFunction } from "express";
import { Resend } from "resend";
import { marked } from "marked";
import * as cheerio from "cheerio";
import { createHmac, timingSafeEqual } from "crypto";
import dotenv from "dotenv";

dotenv.config();

// ─── Config ──────────────────────────────────────────────────────────────────

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;
const EMAIL_FROM = process.env.EMAIL_FROM;
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO;
const SEND_API_KEY = process.env.SEND_API_KEY;
const UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET;
const SERVER_URL = (process.env.SERVER_URL ?? "https://paradoxofacceptance.xyz").replace(/\/$/, "");
const ALLOW_FULL_LIST_SEND = process.env.ALLOW_FULL_LIST_SEND === "true";
const PORT = parseInt(process.env.PORT || "3200", 10);

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

// ─── App ─────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "2mb" }));

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

// ─── Start ────────────────────────────────────────────────────────────────────

validateConfig();
app.listen(PORT, "127.0.0.1", () => {
  console.log(`Newsletter pipeline listening on http://127.0.0.1:${PORT}`);
  console.log(`  Full-list send: ${ALLOW_FULL_LIST_SEND ? "✅ ENABLED" : "🔒 BLOCKED"}`);
  console.log(`  Audience: ${RESEND_AUDIENCE_ID}`);
  console.log(`  From: ${EMAIL_FROM}`);
});

export { app };
