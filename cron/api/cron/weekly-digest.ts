/**
 * /api/cron/weekly-digest
 *
 * Vercel cron job — runs every Sunday at 9am CT (14:00 UTC).
 * Sends a branded weekly digest email to all Resend subscribers:
 *   - Top 3 community posts (by reply count, last 7 days)
 *   - Top 3 Q&A questions (last 7 days)
 *
 * Auth: Vercel cron invocations include `Authorization: Bearer $CRON_SECRET`.
 *
 * Graceful skips (returns 200):
 *   - RESEND_API_KEY not set
 *   - Fewer than 2 community posts in the window
 *
 * Schedule: 0 14 * * 0 (see vercel.json)
 *
 * Required env vars:
 *   CRON_SECRET           — Vercel auto-injects; set in Vercel dashboard too
 *   RESEND_API_KEY        — Resend API key
 *   RESEND_AUDIENCE_ID    — Resend audience (subscriber list)
 *   EMAIL_FROM            — verified sender address
 *   EMAIL_REPLY_TO        — optional reply-to
 *   SUPABASE_URL          — Supabase project URL (optional — skips logging if absent)
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key (optional)
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";

// ─── Config ──────────────────────────────────────────────────────────────────

const CRON_SECRET = process.env.CRON_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;
const EMAIL_FROM = process.env.EMAIL_FROM ?? "newsletter@paradoxofacceptance.xyz";
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SITE_URL = "https://paradoxofacceptance.xyz";
const WINDOW_DAYS = 7;

// ─── Types ───────────────────────────────────────────────────────────────────

interface CommunityPost {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  reply_count: number;
  created_at: string;
}

interface CommunityQA {
  id: string;
  question: string;
  answer: string | null;
  created_at: string;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Only GET and POST are used by Vercel cron; reject others
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Auth: Vercel cron sends Authorization: Bearer <CRON_SECRET>
  if (CRON_SECRET) {
    const authHeader = req.headers["authorization"] ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (token !== CRON_SECRET) {
      console.error("weekly-digest: unauthorized request");
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  // Graceful skip: no Resend key
  if (!RESEND_API_KEY) {
    console.log("weekly-digest: RESEND_API_KEY not set — skipping");
    return res.status(200).json({ skipped: true, reason: "RESEND_API_KEY not set" });
  }

  if (!RESEND_AUDIENCE_ID) {
    console.log("weekly-digest: RESEND_AUDIENCE_ID not set — skipping");
    return res.status(200).json({ skipped: true, reason: "RESEND_AUDIENCE_ID not set" });
  }

  const supabase =
    SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
      ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
      : null;

  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // ── Query community posts ─────────────────────────────────────────────────
  let topPosts: CommunityPost[] = [];
  let topQAs: CommunityQA[] = [];

  if (supabase) {
    const { data: posts, error: postsError } = await supabase
      .from("community_posts")
      .select("id, title, slug, excerpt, reply_count, created_at")
      .gte("created_at", windowStart)
      .order("reply_count", { ascending: false })
      .limit(3);

    if (postsError) {
      console.error("weekly-digest: error fetching posts:", postsError.message);
    } else {
      topPosts = posts ?? [];
    }

    const { data: qas, error: qasError } = await supabase
      .from("community_qa")
      .select("id, question, answer, created_at")
      .gte("created_at", windowStart)
      .order("created_at", { ascending: false })
      .limit(3);

    if (qasError) {
      console.error("weekly-digest: error fetching Q&A:", qasError.message);
    } else {
      topQAs = qas ?? [];
    }
  } else {
    console.log("weekly-digest: Supabase not configured — community data will be empty");
  }

  // Graceful skip: fewer than 2 posts
  if (topPosts.length < 2) {
    console.log(
      `weekly-digest: only ${topPosts.length} post(s) this week — skipping (minimum 2 required)`
    );
    return res.status(200).json({
      skipped: true,
      reason: "fewer than 2 community posts this week",
      postCount: topPosts.length,
    });
  }

  // ── Fetch active subscriber count from Resend ─────────────────────────────
  const resend = new Resend(RESEND_API_KEY);
  let subscriberCount = 0;

  try {
    // Resend doesn't have a direct "count" endpoint; we use the contacts list
    // to verify the audience is accessible and get an approximate count.
    const { data: contacts, error: contactsError } = await (resend as any).contacts.list({
      audienceId: RESEND_AUDIENCE_ID,
    });

    if (contactsError) {
      console.warn("weekly-digest: could not fetch subscriber count:", contactsError);
    } else {
      subscriberCount = contacts?.data?.length ?? 0;
    }
  } catch (err) {
    console.warn("weekly-digest: subscriber count fetch failed:", err);
  }

  // ── Build email ───────────────────────────────────────────────────────────
  const weekLabel = formatWeekLabel();
  const subject = `This week at Paradox of Acceptance — ${weekLabel}`;
  const html = buildEmailHtml({ topPosts, topQAs, weekLabel });

  // ── Send via Resend broadcast ─────────────────────────────────────────────
  let broadcastId: string | null = null;
  let sendStatus: "sent" | "failed" = "failed";
  let sendError: string | null = null;

  try {
    const { data: broadcast, error: createError } = await (resend as any).broadcasts.create({
      audienceId: RESEND_AUDIENCE_ID,
      from: EMAIL_FROM,
      replyTo: EMAIL_REPLY_TO,
      subject,
      html,
    });

    if (createError || !broadcast) {
      throw new Error(createError?.message ?? "broadcast create returned null");
    }

    broadcastId = broadcast.id;

    const { error: sendErr } = await (resend as any).broadcasts.send(broadcast.id);
    if (sendErr) {
      throw new Error(sendErr.message ?? "broadcast send failed");
    }

    sendStatus = "sent";
    console.log(`weekly-digest: broadcast sent — id=${broadcast.id}`);
  } catch (err: unknown) {
    sendError = err instanceof Error ? err.message : String(err);
    console.error("weekly-digest: send failed:", sendError);
  }

  // ── Log to Supabase email_sends ───────────────────────────────────────────
  if (supabase) {
    const { error: logError } = await supabase.from("email_sends").insert({
      type: "weekly_digest",
      subject,
      broadcast_id: broadcastId,
      recipient_count: subscriberCount,
      post_count: topPosts.length,
      qa_count: topQAs.length,
      status: sendStatus,
      error: sendError,
    });

    if (logError) {
      console.error("weekly-digest: failed to log to email_sends:", logError.message);
    }
  }

  if (sendStatus === "failed") {
    return res.status(500).json({ error: sendError ?? "send failed" });
  }

  return res.status(200).json({
    sent: true,
    broadcastId,
    subject,
    postCount: topPosts.length,
    qaCount: topQAs.length,
    recipientCount: subscriberCount,
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatWeekLabel(): string {
  const now = new Date();
  return now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function postUrl(post: CommunityPost): string {
  return `${SITE_URL}/community/${post.slug}`;
}

function buildEmailHtml({
  topPosts,
  topQAs,
  weekLabel,
}: {
  topPosts: CommunityPost[];
  topQAs: CommunityQA[];
  weekLabel: string;
}): string {
  const postsHtml = topPosts
    .map(
      (post, i) => `
      <div style="margin-bottom:28px;padding-bottom:24px;${i < topPosts.length - 1 ? "border-bottom:1px solid #e8e4dc;" : ""}">
        <a href="${postUrl(post)}" style="font-family:system-ui,-apple-system,sans-serif;font-size:17px;font-weight:600;color:#2c2c2c;text-decoration:none;">
          ${escapeHtml(post.title)}
        </a>
        ${post.excerpt ? `<p style="margin:8px 0 0;font-size:16px;line-height:1.6;color:#555;">${escapeHtml(post.excerpt)}</p>` : ""}
        <p style="margin:8px 0 0;font-size:14px;color:#888;">
          ${post.reply_count} ${post.reply_count === 1 ? "reply" : "replies"}
        </p>
      </div>`
    )
    .join("");

  const qasHtml =
    topQAs.length > 0
      ? topQAs
          .map(
            (qa, i) => `
        <div style="margin-bottom:24px;${i < topQAs.length - 1 ? "padding-bottom:20px;border-bottom:1px solid #e8e4dc;" : ""}">
          <p style="margin:0 0 8px;font-family:system-ui,-apple-system,sans-serif;font-size:16px;font-weight:600;color:#2c2c2c;">
            Q: ${escapeHtml(qa.question)}
          </p>
          ${qa.answer ? `<p style="margin:0;font-size:16px;line-height:1.6;color:#555;">A: ${escapeHtml(qa.answer)}</p>` : '<p style="margin:0;font-size:14px;color:#888;font-style:italic;">This question is open — share your perspective.</p>'}
        </div>`
          )
          .join("")
      : "";

  const qaSectionHtml =
    topQAs.length > 0
      ? `
      <div style="margin-top:40px;">
        <h2 style="font-family:system-ui,-apple-system,sans-serif;font-size:18px;font-weight:600;color:#2c2c2c;margin:0 0 20px;padding-bottom:12px;border-bottom:2px solid #7d8c6e;">
          Questions &amp; Answers
        </h2>
        ${qasHtml}
      </div>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Weekly Digest — Paradox of Acceptance</title>
</head>
<body style="margin:0;padding:0;background-color:#faf8f4;font-family:Georgia,serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#faf8f4;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width:680px;" cellpadding="0" cellspacing="0">

          <!-- Header -->
          <tr>
            <td style="padding-bottom:32px;border-bottom:2px solid #7d8c6e;">
              <a href="${SITE_URL}" style="font-family:system-ui,-apple-system,sans-serif;font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#7d8c6e;text-decoration:none;">
                Paradox of Acceptance
              </a>
              <h1 style="margin:12px 0 4px;font-family:Georgia,serif;font-size:26px;font-weight:normal;color:#2c2c2c;line-height:1.3;">
                This Week in the Community
              </h1>
              <p style="margin:0;font-family:system-ui,-apple-system,sans-serif;font-size:14px;color:#888;">
                ${escapeHtml(weekLabel)}
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding-top:36px;">

              <!-- Top posts -->
              <h2 style="font-family:system-ui,-apple-system,sans-serif;font-size:18px;font-weight:600;color:#2c2c2c;margin:0 0 20px;padding-bottom:12px;border-bottom:2px solid #7d8c6e;">
                Top Discussions
              </h2>
              ${postsHtml}

              ${qaSectionHtml}

              <!-- CTA -->
              <div style="margin-top:44px;padding:28px;background-color:#f0ede6;border-radius:6px;text-align:center;">
                <p style="margin:0 0 16px;font-size:17px;color:#2c2c2c;line-height:1.5;">
                  Join the conversation and share what practice means to you.
                </p>
                <a href="${SITE_URL}/community"
                   style="display:inline-block;padding:12px 28px;background-color:#7d8c6e;color:#fff;font-family:system-ui,-apple-system,sans-serif;font-size:15px;font-weight:600;text-decoration:none;border-radius:4px;letter-spacing:0.02em;">
                  Visit Community
                </a>
              </div>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding-top:40px;padding-bottom:24px;border-top:1px solid #e0dcd4;margin-top:40px;">
              <p style="margin:0 0 8px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:#999;text-align:center;">
                <a href="${SITE_URL}" style="color:#7d8c6e;text-decoration:none;">paradoxofacceptance.xyz</a>
                &nbsp;·&nbsp;
                <a href="${SITE_URL}/mindfulness-essays/" style="color:#7d8c6e;text-decoration:none;">Essays</a>
                &nbsp;·&nbsp;
                <a href="${SITE_URL}/courses/" style="color:#7d8c6e;text-decoration:none;">Course</a>
              </p>
              <p style="margin:0;font-family:system-ui,-apple-system,sans-serif;font-size:12px;color:#bbb;text-align:center;">
                You're receiving this because you subscribed to Paradox of Acceptance.
                <br />
                <a href="{{unsubscribe}}" style="color:#bbb;">Unsubscribe</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
