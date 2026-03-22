/**
 * /api/cron/weekly-digest
 *
 * Vercel cron job — runs every Sunday at 9am CT (14:00 UTC).
 * Sends a personalized weekly digest to each subscriber based on their
 * digest_channels preference (OLU-430). Subscribers who have selected
 * specific channels only receive posts from those channels.
 *
 * Send strategy: individual batch sends via resend.batch.send (not broadcasts),
 * enabling per-subscriber channel filtering.
 *
 * Auth: Vercel cron invocations include `Authorization: Bearer $CRON_SECRET`.
 *
 * Graceful skips (returns 200):
 *   - RESEND_API_KEY not set
 *   - Fewer than 2 community posts in the window (across all channels)
 *
 * Schedule: 0 14 * * 0 (see vercel.json)
 *
 * Required env vars:
 *   CRON_SECRET           — Vercel auto-injects; set in Vercel dashboard too
 *   RESEND_API_KEY        — Resend API key
 *   RESEND_AUDIENCE_ID    — Resend audience (subscriber list)
 *   EMAIL_FROM            — verified sender address
 *   SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 *
 * Optional env vars:
 *   EMAIL_REPLY_TO        — reply-to address
 *   UNSUBSCRIBE_SECRET    — HMAC secret for generating per-subscriber unsubscribe tokens
 *   PREFERENCES_JWT_SECRET — JWT secret for generating manage-preferences links
 *   SERVER_URL            — base URL for preference/unsubscribe links (default: paradoxofacceptance.xyz)
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Resend } from "resend";
import { createClient } from "@supabase/supabase-js";
import { createHmac } from "crypto";

// ─── Config ──────────────────────────────────────────────────────────────────

const CRON_SECRET = process.env.CRON_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;
const EMAIL_FROM = process.env.EMAIL_FROM ?? "newsletter@paradoxofacceptance.xyz";
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET;
const PREFERENCES_JWT_SECRET = process.env.PREFERENCES_JWT_SECRET;
const SERVER_URL = (process.env.SERVER_URL ?? "https://paradoxofacceptance.xyz").replace(/\/$/, "");

const SITE_URL = SERVER_URL;
const WINDOW_DAYS = 7;
const BATCH_SIZE = 100;

// ─── Types ───────────────────────────────────────────────────────────────────

interface Channel {
  id: string;
  slug: string;
  name: string;
}

interface CommunityPost {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  reply_count: number;
  created_at: string;
  channel_id: string | null;
}

interface SubscriberPrefs {
  subscriber_id: string;
  weekly_digest: boolean;
  digest_channels: string[] | null;
}

interface Contact {
  email: string;
  firstName?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatWeekLabel(): string {
  const now = new Date();
  return now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function postUrl(post: CommunityPost): string {
  return `${SITE_URL}/community/${post.slug}`;
}

function generateUnsubscribeToken(email: string): string | null {
  if (!UNSUBSCRIBE_SECRET) return null;
  const hmac = createHmac("sha256", UNSUBSCRIBE_SECRET);
  hmac.update(email.toLowerCase().trim());
  return hmac.digest("hex");
}

function generatePreferencesToken(email: string): string | null {
  if (!PREFERENCES_JWT_SECRET) return null;
  // Minimal HS256 JWT without external deps
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const expiry = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days
  const payload = Buffer.from(JSON.stringify({ sub: email.toLowerCase().trim(), exp: expiry })).toString("base64url");
  const sig = createHmac("sha256", PREFERENCES_JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine which posts a subscriber should receive based on their digest_channels preference.
 * NULL or empty array = all posts (graceful fallback).
 */
function filterPostsForSubscriber(
  allPosts: CommunityPost[],
  channelIdsBySlugs: Map<string, string>,
  prefs: SubscriberPrefs | null
): CommunityPost[] {
  const digestChannels = prefs?.digest_channels;

  // NULL or empty → all posts
  if (!digestChannels || digestChannels.length === 0) {
    return allPosts;
  }

  // Map selected slugs to channel IDs
  const selectedIds = new Set(
    digestChannels.map((slug) => channelIdsBySlugs.get(slug)).filter((id): id is string => id != null)
  );

  // If none of the selected channels resolve to known IDs, fall back to all
  if (selectedIds.size === 0) {
    return allPosts;
  }

  return allPosts.filter((p) => p.channel_id != null && selectedIds.has(p.channel_id));
}

// ─── Email builder ────────────────────────────────────────────────────────────

function buildEmailHtml({
  topPosts,
  weekLabel,
  unsubscribeUrl,
  preferencesUrl,
}: {
  topPosts: CommunityPost[];
  weekLabel: string;
  unsubscribeUrl: string;
  preferencesUrl: string | null;
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

  const manageLink = preferencesUrl
    ? `&nbsp;·&nbsp;<a href="${preferencesUrl}" style="color:#bbb;">Manage preferences</a>`
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
                <a href="${unsubscribeUrl}" style="color:#bbb;">Unsubscribe</a>${manageLink}
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

// ─── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

  // ── Fetch channels (slug → id map) ───────────────────────────────────────
  const channelIdsBySlugs = new Map<string, string>();

  if (supabase) {
    const { data: channelRows, error: channelsError } = await supabase
      .from("channels")
      .select("id, slug");

    if (channelsError) {
      console.warn("weekly-digest: failed to fetch channels:", channelsError.message);
    } else {
      for (const ch of channelRows ?? []) {
        channelIdsBySlugs.set(ch.slug, ch.id);
      }
    }
  }

  // ── Fetch all posts from past 7 days ──────────────────────────────────────
  let allPosts: CommunityPost[] = [];

  if (supabase) {
    const { data: posts, error: postsError } = await supabase
      .from("community_posts")
      .select("id, title, slug, excerpt, reply_count, created_at, channel_id")
      .gte("created_at", windowStart)
      .eq("published", true)
      .order("reply_count", { ascending: false })
      .limit(50); // fetch more than needed so per-channel top-3 works

    if (postsError) {
      console.error("weekly-digest: error fetching posts:", postsError.message);
    } else {
      allPosts = posts ?? [];
    }
  }

  // Graceful skip: fewer than 2 posts total
  if (allPosts.length < 2) {
    console.log(
      `weekly-digest: only ${allPosts.length} post(s) this week — skipping (minimum 2 required)`
    );
    return res.status(200).json({
      skipped: true,
      reason: "fewer than 2 community posts this week",
      postCount: allPosts.length,
    });
  }

  // ── Fetch Resend audience contacts ────────────────────────────────────────
  const resend = new Resend(RESEND_API_KEY);
  let contacts: Contact[] = [];

  try {
    const { data: contactsData, error: contactsError } = await (resend as any).contacts.list({
      audienceId: RESEND_AUDIENCE_ID,
    });

    if (contactsError) {
      console.error("weekly-digest: failed to fetch audience contacts:", contactsError);
      return res.status(500).json({ error: "Failed to fetch audience contacts" });
    }

    contacts = ((contactsData?.data ?? []) as Array<{
      email: string;
      firstName?: string;
      unsubscribed: boolean;
    }>)
      .filter((c) => !c.unsubscribed)
      .map((c) => ({ email: c.email.toLowerCase(), firstName: c.firstName }));
  } catch (err) {
    console.error("weekly-digest: contacts fetch threw:", err);
    return res.status(500).json({ error: "Failed to fetch audience contacts" });
  }

  if (contacts.length === 0) {
    console.log("weekly-digest: no active subscribers — skipping");
    return res.status(200).json({ skipped: true, reason: "no active subscribers" });
  }

  // ── Fetch subscriber preferences for all contacts ─────────────────────────
  const prefsMap = new Map<string, SubscriberPrefs>();

  if (supabase && contacts.length > 0) {
    const emails = contacts.map((c) => c.email);

    // Supabase .in() supports up to 1000 values; paginate if needed
    const PAGE = 500;
    for (let i = 0; i < emails.length; i += PAGE) {
      const batch = emails.slice(i, i + PAGE);
      const { data: prefsRows, error: prefsError } = await supabase
        .from("subscriber_preferences")
        .select("subscriber_id, weekly_digest, digest_channels")
        .in("subscriber_id", batch);

      if (prefsError) {
        console.warn("weekly-digest: failed to fetch preferences batch:", prefsError.message);
      } else {
        for (const row of prefsRows ?? []) {
          prefsMap.set(row.subscriber_id.toLowerCase(), row);
        }
      }
    }
  }

  // ── Build per-subscriber send queue ──────────────────────────────────────
  const weekLabel = formatWeekLabel();
  const subject = `This week at Paradox of Acceptance — ${weekLabel}`;

  interface EmailPayload {
    from: string;
    to: string;
    replyTo?: string;
    subject: string;
    html: string;
  }

  const sendQueue: EmailPayload[] = [];

  for (const contact of contacts) {
    const prefs = prefsMap.get(contact.email) ?? null;

    // Skip subscribers who opted out of weekly digest
    if (prefs?.weekly_digest === false) continue;

    // Get their filtered top-3 posts
    const subscriberPosts = filterPostsForSubscriber(allPosts, channelIdsBySlugs, prefs).slice(0, 3);

    // Graceful: if they've selected specific channels and there are no posts in
    // those channels this week, use all posts as fallback
    const postsToSend = subscriberPosts.length === 0 ? allPosts.slice(0, 3) : subscriberPosts;

    // Generate per-subscriber links
    const unsubToken = generateUnsubscribeToken(contact.email);
    const unsubscribeUrl = unsubToken
      ? `${SERVER_URL}/api/unsubscribe?token=${unsubToken}`
      : `${SERVER_URL}/unsubscribe`;

    const prefToken = generatePreferencesToken(contact.email);
    const preferencesUrl = prefToken ? `${SERVER_URL}/email/preferences/?token=${prefToken}` : null;

    const html = buildEmailHtml({
      topPosts: postsToSend,
      weekLabel,
      unsubscribeUrl,
      preferencesUrl,
    });

    const payload: EmailPayload = {
      from: EMAIL_FROM,
      to: contact.email,
      subject,
      html,
    };
    if (EMAIL_REPLY_TO) payload.replyTo = EMAIL_REPLY_TO;
    sendQueue.push(payload);
  }

  if (sendQueue.length === 0) {
    console.log("weekly-digest: no subscribers to send to after preference filtering — skipping");
    return res.status(200).json({ skipped: true, reason: "all subscribers opted out" });
  }

  // ── Send in batches ───────────────────────────────────────────────────────
  let sent = 0;
  let errors = 0;

  for (let i = 0; i < sendQueue.length; i += BATCH_SIZE) {
    const batch = sendQueue.slice(i, i + BATCH_SIZE);
    try {
      const { data, error: sendErr } = await resend.batch.send(batch as any);
      if (sendErr) {
        console.error(`weekly-digest: batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, sendErr);
        errors += batch.length;
      } else {
        const batchSent = Array.isArray(data) ? data.length : batch.length;
        sent += batchSent;
        console.log(
          `weekly-digest: batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(sendQueue.length / BATCH_SIZE)} — sent ${batchSent}`
        );
      }
    } catch (err) {
      console.error(`weekly-digest: batch ${Math.floor(i / BATCH_SIZE) + 1} threw:`, err);
      errors += batch.length;
    }

    if (i + BATCH_SIZE < sendQueue.length) {
      await sleep(500);
    }
  }

  const sendStatus = errors === 0 ? "sent" : sent > 0 ? "partial" : "failed";

  // ── Log to Supabase email_sends ───────────────────────────────────────────
  if (supabase) {
    const { error: logError } = await supabase.from("email_sends").insert({
      type: "weekly_digest",
      subject,
      broadcast_id: null,
      recipient_count: sent,
      post_count: allPosts.length,
      qa_count: 0,
      status: sendStatus === "failed" ? "failed" : "sent",
      error: errors > 0 ? `${errors} batch error(s)` : null,
    });

    if (logError) {
      console.error("weekly-digest: failed to log to email_sends:", logError.message);
    }
  }

  if (sendStatus === "failed") {
    return res.status(500).json({ error: "All batches failed", sent, errors });
  }

  return res.status(200).json({
    sent,
    errors,
    skipped: contacts.length - sendQueue.length,
    subject,
    postCount: allPosts.length,
  });
}
