/**
 * /api/cron/reengagement
 *
 * Vercel cron job — runs daily at 10am CT (16:00 UTC).
 * Sends a personalized re-engagement email to subscribers who have been
 * inactive for exactly 7 days (last_active_at in the 7–8 day window).
 *
 * Query window: last_active_at < NOW() - 7 days AND last_active_at > NOW() - 8 days
 * Idempotency: has_received_reengagement_email = false prevents duplicate sends.
 *
 * Personalization by last_activity_type:
 *   qa        — "We have new insights since you left"
 *   community — "The community has been active"
 *   course    — "Ready to continue your course?"
 *   null      — generic "We miss you" fallback
 *
 * After sending: sets has_received_reengagement_email = true, reengagement_sent_at = NOW().
 *
 * Re-engagement reset: when user clicks the email link, the Resend webhook
 * (POST /api/webhooks/resend) clears has_received_reengagement_email so they
 * can receive another re-engagement email after another 7-day gap.
 *
 * Schedule: 0 16 * * * (16:00 UTC = 10am CDT / 11am CST — see vercel.json)
 *
 * Required env vars:
 *   CRON_SECRET               — Vercel auto-injects; set in Vercel dashboard too
 *   RESEND_API_KEY            — Resend API key (graceful skip if absent)
 *   EMAIL_FROM                — verified sender address
 *   EMAIL_REPLY_TO            — optional reply-to
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Resend } from "resend";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ─── Config ───────────────────────────────────────────────────────────────────

const CRON_SECRET = process.env.CRON_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM ?? "hello@paradoxofacceptance.xyz";
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO;
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const SITE_URL = "https://paradoxofacceptance.xyz";

// Exactly 7-day inactivity window — users inactive for 7–8 days, checked once daily
const WINDOW_DAYS = 7;

// ─── Types ────────────────────────────────────────────────────────────────────

type ActivityType = "qa" | "community" | "course" | null;

interface Subscriber {
  email: string;
  first_name: string | null;
  last_active_at: string | null;
  last_activity_type: ActivityType;
}

interface SendResult {
  email: string;
  activityType: ActivityType;
  resendEmailId: string | null;
  error: string | null;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Auth
  if (CRON_SECRET) {
    const authHeader = req.headers["authorization"] ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (token !== CRON_SECRET) {
      console.error("reengagement: unauthorized request");
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  // Graceful skip: Resend key not yet provisioned
  if (!RESEND_API_KEY) {
    console.log("reengagement: RESEND_API_KEY not set — skipping (will activate on provision)");
    return res.status(200).json({ skipped: true, reason: "RESEND_API_KEY not set" });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("reengagement: Supabase env vars not set");
    return res.status(500).json({ error: "Supabase not configured" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const resend = new Resend(RESEND_API_KEY);

  const now = new Date();
  const windowStart = new Date(now.getTime() - (WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000); // 8 days ago
  const windowEnd = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);           // 7 days ago

  console.log(
    `reengagement: window=[${windowStart.toISOString()}, ${windowEnd.toISOString()}]`
  );

  // Query: active subscribers, not yet re-engaged, last_active_at in the 7–8 day window
  const { data: candidates, error: fetchError } = await supabase
    .from("subscribers")
    .select("email, first_name, last_active_at, last_activity_type")
    .eq("status", "active")
    .eq("has_received_reengagement_email", false)
    .lt("last_active_at", windowEnd.toISOString())
    .gte("last_active_at", windowStart.toISOString());

  if (fetchError) {
    console.error(`reengagement: failed to fetch candidates: ${fetchError.message}`);
    return res.status(500).json({ error: fetchError.message });
  }

  if (!candidates || candidates.length === 0) {
    console.log("reengagement: no candidates in window");
    return res.status(200).json({ sent: 0, failed: 0, results: [] });
  }

  console.log(`reengagement: ${candidates.length} candidate(s) found`);

  // Fetch the most recent community post (used by community-type personalization)
  let topPostSinceTitle: string | null = null;
  let topPostSinceUrl: string | null = null;
  try {
    const { data: posts } = await supabase
      .from("community_posts")
      .select("title, slug, created_at")
      .eq("published", true)
      .order("created_at", { ascending: false })
      .limit(1);
    if (posts && posts.length > 0) {
      topPostSinceTitle = posts[0].title as string;
      topPostSinceUrl = `${SITE_URL}/community/${posts[0].slug}`;
    }
  } catch {
    // Non-fatal — fall back to generic community copy
  }

  const results: SendResult[] = [];

  for (const subscriber of candidates as Subscriber[]) {
    const result = await sendReengagementEmail(
      subscriber,
      resend,
      supabase,
      topPostSinceTitle,
      topPostSinceUrl
    );
    results.push(result);
  }

  const totalSent = results.filter((r) => !r.error).length;
  const totalFailed = results.filter((r) => r.error).length;

  console.log(`reengagement: done — sent=${totalSent} failed=${totalFailed}`);

  return res.status(200).json({ sent: totalSent, failed: totalFailed, results });
}

// ─── Email sender ─────────────────────────────────────────────────────────────

async function sendReengagementEmail(
  subscriber: Subscriber,
  resend: Resend,
  supabase: SupabaseClient,
  topPostTitle: string | null,
  topPostUrl: string | null
): Promise<SendResult> {
  const activityType = subscriber.last_activity_type;

  // Per-send suppression check (defense in depth — catches status changes since batch query)
  const { data: subRow } = await supabase
    .from("subscribers")
    .select("status")
    .eq("email", subscriber.email)
    .single();

  if (subRow && subRow.status !== "active") {
    console.log(`reengagement: skipping ${subscriber.email} — status=${subRow.status}`);
    return { email: subscriber.email, activityType, resendEmailId: null, error: null };
  }

  // Check email preferences
  const { data: pref } = await supabase
    .from("subscriber_preferences")
    .select("newsletter")
    .eq("subscriber_id", subscriber.email)
    .maybeSingle();

  if (pref && pref.newsletter === false) {
    console.log(`reengagement: skipping ${subscriber.email} — opted out of newsletter`);
    return { email: subscriber.email, activityType, resendEmailId: null, error: null };
  }

  const unsubscribeUrl = `${SITE_URL}/unsubscribe?email=${encodeURIComponent(subscriber.email)}`;
  const emailContent = buildEmailContent(
    activityType,
    subscriber.first_name,
    unsubscribeUrl,
    topPostTitle,
    topPostUrl
  );

  let resendEmailId: string | null = null;
  let sendError: string | null = null;

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to: subscriber.email,
      ...(EMAIL_REPLY_TO ? { replyTo: EMAIL_REPLY_TO } : {}),
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
      // Tag for click tracking via webhook — used to reset has_received_reengagement_email
      tags: [
        { name: "sequence", value: "reengagement" },
        { name: "activity_type", value: activityType ?? "generic" },
      ],
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    if (error) throw new Error(error.message);

    resendEmailId = data?.id ?? null;

    // Mark as sent — idempotency gate + timestamp
    const { error: updateError } = await supabase
      .from("subscribers")
      .update({
        has_received_reengagement_email: true,
        reengagement_sent_at: new Date().toISOString(),
      })
      .eq("email", subscriber.email);

    if (updateError) {
      // Email was sent — log but don't treat as send failure
      console.error(
        `reengagement: DB update failed for ${subscriber.email}: ${updateError.message}`
      );
    }

    console.log(
      `reengagement: sent to ${subscriber.email} (type=${activityType ?? "generic"}) resend_id=${resendEmailId}`
    );
  } catch (err: unknown) {
    sendError = err instanceof Error ? err.message : String(err);
    console.error(`reengagement: send failed for ${subscriber.email}: ${sendError}`);
  }

  return { email: subscriber.email, activityType, resendEmailId, error: sendError };
}

// ─── Email content builder ────────────────────────────────────────────────────

interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

function buildEmailContent(
  activityType: ActivityType,
  firstName: string | null,
  unsubscribeUrl: string,
  topPostTitle: string | null,
  topPostUrl: string | null
): EmailContent {
  switch (activityType) {
    case "qa":
      return buildQaEmail(firstName, unsubscribeUrl);
    case "community":
      return buildCommunityEmail(firstName, unsubscribeUrl, topPostTitle, topPostUrl);
    case "course":
      return buildCourseEmail(firstName, unsubscribeUrl);
    default:
      return buildGenericEmail(firstName, unsubscribeUrl);
  }
}

// ─── Q&A variant ─────────────────────────────────────────────────────────────

function buildQaEmail(firstName: string | null, unsubscribeUrl: string): EmailContent {
  const greeting = firstName ? `Hey ${escapeHtml(firstName)},` : "Hey,";
  const greetingText = firstName ? `Hey ${firstName},` : "Hey,";

  return {
    subject: "We have new insights since you left",
    html: buildHtml({
      preheader: "Questions asked. Answers written. Worth coming back for.",
      heading: "New insights since you left.",
      unsubscribeUrl,
      body: `
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          ${greeting}
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          The Q&amp;A section has been active since you were last here. New questions have come in.
          Some have answers now that didn't before.
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          The best ones are the kind you don't expect to find useful until you do.
        </p>
        <div style="text-align:center;margin:36px 0;">
          <a href="${SITE_URL}/community/"
             style="display:inline-block;padding:14px 32px;background-color:#7d8c6e;color:#fff;font-family:system-ui,-apple-system,sans-serif;font-size:15px;font-weight:600;text-decoration:none;border-radius:4px;letter-spacing:0.02em;">
            See What's New
          </a>
        </div>
        <p style="margin:0;font-size:16px;line-height:1.7;color:#555;">
          — N
        </p>
      `,
    }),
    text: `${greetingText}

The Q&A section has been active since you were last here. New questions have come in. Some have answers now that didn't before.

The best ones are the kind you don't expect to find useful until you do.

See what's new: ${SITE_URL}/community/

— N

---
${unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : ""}`.trim(),
  };
}

// ─── Community variant ────────────────────────────────────────────────────────

function buildCommunityEmail(
  firstName: string | null,
  unsubscribeUrl: string,
  topPostTitle: string | null,
  topPostUrl: string | null
): EmailContent {
  const greeting = firstName ? `Hey ${escapeHtml(firstName)},` : "Hey,";
  const greetingText = firstName ? `Hey ${firstName},` : "Hey,";
  const hasPost = topPostTitle && topPostUrl;

  const postBlock = hasPost
    ? `
        <div style="margin:28px 0;padding:24px;background-color:#f0ede6;border-left:3px solid #7d8c6e;">
          <p style="margin:0 0 8px;font-family:system-ui,-apple-system,sans-serif;font-size:14px;font-weight:600;color:#7d8c6e;text-transform:uppercase;letter-spacing:0.08em;">
            Recent discussion
          </p>
          <p style="margin:0;font-size:17px;line-height:1.6;color:#2c2c2c;font-style:italic;">
            "${escapeHtml(topPostTitle!)}"
          </p>
        </div>`
    : "";

  const postTextBlock = hasPost
    ? `\nLatest discussion: "${topPostTitle}"\n${topPostUrl}\n`
    : "";

  return {
    subject: "The community has been active",
    html: buildHtml({
      preheader: "People are talking. Here's what you missed.",
      heading: "Things have been moving.",
      unsubscribeUrl,
      body: `
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          ${greeting}
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          The community has been active since you were last here.
        </p>
        ${postBlock}
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          Worth catching up on.
        </p>
        <div style="text-align:center;margin:36px 0;">
          <a href="${SITE_URL}/community/"
             style="display:inline-block;padding:14px 32px;background-color:#7d8c6e;color:#fff;font-family:system-ui,-apple-system,sans-serif;font-size:15px;font-weight:600;text-decoration:none;border-radius:4px;letter-spacing:0.02em;">
            See the Community
          </a>
        </div>
        <p style="margin:0;font-size:16px;line-height:1.7;color:#555;">
          — N
        </p>
      `,
    }),
    text: `${greetingText}

The community has been active since you were last here.
${postTextBlock}
Worth catching up on.

See the community: ${SITE_URL}/community/

— N

---
${unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : ""}`.trim(),
  };
}

// ─── Course variant ───────────────────────────────────────────────────────────

function buildCourseEmail(firstName: string | null, unsubscribeUrl: string): EmailContent {
  const greeting = firstName ? `Hey ${escapeHtml(firstName)},` : "Hey,";
  const greetingText = firstName ? `Hey ${firstName},` : "Hey,";

  return {
    subject: "Ready to continue your course?",
    html: buildHtml({
      preheader: "You were making progress. Pick up where you left off.",
      heading: "Ready to continue?",
      unsubscribeUrl,
      body: `
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          ${greeting}
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          You were making progress on the course before you stepped away. That progress is still there.
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          The next session is waiting whenever you're ready.
        </p>
        <div style="text-align:center;margin:36px 0;">
          <a href="${SITE_URL}/courses/"
             style="display:inline-block;padding:14px 32px;background-color:#7d8c6e;color:#fff;font-family:system-ui,-apple-system,sans-serif;font-size:15px;font-weight:600;text-decoration:none;border-radius:4px;letter-spacing:0.02em;">
            Continue the Course
          </a>
        </div>
        <p style="margin:0;font-size:16px;line-height:1.7;color:#555;">
          — N
        </p>
      `,
    }),
    text: `${greetingText}

You were making progress on the course before you stepped away. That progress is still there.

The next session is waiting whenever you're ready.

Continue the course: ${SITE_URL}/courses/

— N

---
${unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : ""}`.trim(),
  };
}

// ─── Generic fallback variant ─────────────────────────────────────────────────

function buildGenericEmail(firstName: string | null, unsubscribeUrl: string): EmailContent {
  const greeting = firstName ? `Hey ${escapeHtml(firstName)},` : "Hey,";
  const greetingText = firstName ? `Hey ${firstName},` : "Hey,";

  return {
    subject: "It's been a while",
    html: buildHtml({
      preheader: "Things have been moving on the site. Come back when you're ready.",
      heading: "It's been a while.",
      unsubscribeUrl,
      body: `
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          ${greeting}
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          It's been a week since you were last here. New essays, discussions, and answers
          have come in since then.
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          Come back when you're ready. It'll be here.
        </p>
        <div style="text-align:center;margin:36px 0;">
          <a href="${SITE_URL}/"
             style="display:inline-block;padding:14px 32px;background-color:#7d8c6e;color:#fff;font-family:system-ui,-apple-system,sans-serif;font-size:15px;font-weight:600;text-decoration:none;border-radius:4px;letter-spacing:0.02em;">
            Visit Paradox of Acceptance
          </a>
        </div>
        <p style="margin:0;font-size:16px;line-height:1.7;color:#555;">
          — N
        </p>
      `,
    }),
    text: `${greetingText}

It's been a week since you were last here. New essays, discussions, and answers have come in since then.

Come back when you're ready. It'll be here.

Visit the site: ${SITE_URL}/

— N

---
${unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : ""}`.trim(),
  };
}

// ─── Email template ───────────────────────────────────────────────────────────

function buildHtml({
  preheader,
  heading,
  body,
  unsubscribeUrl,
}: {
  preheader: string;
  heading: string;
  body: string;
  unsubscribeUrl: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(heading)} — Paradox of Acceptance</title>
</head>
<body style="margin:0;padding:0;background-color:#faf8f4;font-family:Georgia,serif;">
  <!-- preheader (hidden preview text) -->
  <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#faf8f4;line-height:1px;">
    ${escapeHtml(preheader)}&nbsp;&#847;&nbsp;
  </div>
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
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding-top:36px;padding-bottom:36px;">
              <h1 style="margin:0 0 28px;font-family:Georgia,serif;font-size:28px;font-weight:normal;color:#2c2c2c;line-height:1.3;">
                ${escapeHtml(heading)}
              </h1>
              ${body}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding-top:32px;border-top:1px solid #e0dcd4;">
              <p style="margin:0 0 8px;font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:#999;text-align:center;">
                <a href="${SITE_URL}" style="color:#7d8c6e;text-decoration:none;">paradoxofacceptance.xyz</a>
                &nbsp;·&nbsp;
                <a href="${SITE_URL}/mindfulness-essays/" style="color:#7d8c6e;text-decoration:none;">Essays</a>
                &nbsp;·&nbsp;
                <a href="${SITE_URL}/community/" style="color:#7d8c6e;text-decoration:none;">Community</a>
              </p>
              <p style="margin:0;font-family:system-ui,-apple-system,sans-serif;font-size:12px;color:#bbb;text-align:center;">
                You're receiving this because you subscribed to Paradox of Acceptance.
                <br />
                <a href="${escapeHtml(unsubscribeUrl)}" style="color:#bbb;">Unsubscribe</a>
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
