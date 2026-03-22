/**
 * /api/cron/onboarding-sequence
 *
 * Vercel cron job — runs daily at 9am CT (14:00 UTC).
 * For each active subscriber, sends the appropriate onboarding step email
 * based on how many days have passed since they subscribed.
 *
 * Sequence:
 *   Day 0 — Welcome (handled by subscription flow, OLU-109)
 *   Day 1 — Your first essay recommendation
 *   Day 3 — Have you tried the Q&A?
 *   Day 5 — Join the conversation
 *   Day 7 — Your reading streak starts now
 *
 * Idempotency: unique constraint on (subscriber_id, step) prevents duplicate sends.
 * Skips subscribers who have unsubscribed or turned off email preferences.
 * Graceful no-op if RESEND_API_KEY is not set (activates automatically on provision).
 *
 * Open tracking: each email is sent with a tag so the Resend webhook
 * (/api/webhooks/resend) can update onboarding_sequences.opened_at.
 *
 * Schedule: 0 14 * * * (see vercel.json — 14:00 UTC = 9am CT)
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

// ─── Sequence definition ──────────────────────────────────────────────────────

const STEPS = [1, 3, 5, 7] as const;
type Step = (typeof STEPS)[number];

interface StepConfig {
  subject: string;
  buildHtml: (ctx: EmailContext) => string;
  buildText: (ctx: EmailContext) => string;
}

interface EmailContext {
  firstName: string | null;
  email: string;
  unsubscribeUrl: string;
}

const stepConfigs: Record<Step, StepConfig> = {
  1: {
    subject: "Your first read on Paradox of Acceptance",
    buildHtml: (ctx) => buildHtml({
      ctx,
      preheader: "Start here — the essay our readers keep coming back to.",
      heading: "Start here.",
      body: `
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          ${ctx.firstName ? `Hey ${escapeHtml(ctx.firstName)},` : "Hey,"}
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          One essay gets recommended more than any other here. It's the one new readers tend to come back to.
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          If you're going to read one thing on this site, start there.
        </p>
        <div style="text-align:center;margin:36px 0;">
          <a href="${SITE_URL}/mindfulness-essays/"
             style="display:inline-block;padding:14px 32px;background-color:#7d8c6e;color:#fff;font-family:system-ui,-apple-system,sans-serif;font-size:15px;font-weight:600;text-decoration:none;border-radius:4px;letter-spacing:0.02em;">
            Read the Essay
          </a>
        </div>
        <p style="margin:0;font-size:16px;line-height:1.7;color:#555;">
          More coming. — N
        </p>
      `,
    }),
    buildText: (ctx) => `
${ctx.firstName ? `Hey ${ctx.firstName},` : "Hey,"}

One essay gets recommended more than any other here. It's the one new readers tend to come back to.

If you're going to read one thing on this site, start there:
${SITE_URL}/mindfulness-essays/

More coming. — N

---
${ctx.unsubscribeUrl ? `Unsubscribe: ${ctx.unsubscribeUrl}` : ""}
    `.trim(),
  },

  3: {
    subject: "Have you tried the Q&A?",
    buildHtml: (ctx) => buildHtml({
      ctx,
      preheader: "Real questions. Short answers. Worth two minutes.",
      heading: "The Q&A section.",
      body: `
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          ${ctx.firstName ? `Hey ${escapeHtml(ctx.firstName)},` : "Hey,"}
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          The Q&amp;A section is where the interesting stuff happens. Readers ask hard questions —
          about practice, about doubt, about what to do when nothing seems to work.
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          Some questions already have answers. Some are still open — you can weigh in.
        </p>
        <div style="margin:28px 0;padding:24px;background-color:#f0ede6;border-left:3px solid #7d8c6e;">
          <p style="margin:0 0 8px;font-family:system-ui,-apple-system,sans-serif;font-size:14px;font-weight:600;color:#7d8c6e;text-transform:uppercase;letter-spacing:0.08em;">
            Sample question
          </p>
          <p style="margin:0;font-size:17px;line-height:1.6;color:#2c2c2c;font-style:italic;">
            "Is acceptance the same as giving up? Sometimes it feels like the same thing."
          </p>
        </div>
        <div style="text-align:center;margin:36px 0;">
          <a href="${SITE_URL}/community/"
             style="display:inline-block;padding:14px 32px;background-color:#7d8c6e;color:#fff;font-family:system-ui,-apple-system,sans-serif;font-size:15px;font-weight:600;text-decoration:none;border-radius:4px;letter-spacing:0.02em;">
            See the Q&amp;A
          </a>
        </div>
        <p style="margin:0;font-size:16px;line-height:1.7;color:#555;">
          — N
        </p>
      `,
    }),
    buildText: (ctx) => `
${ctx.firstName ? `Hey ${ctx.firstName},` : "Hey,"}

The Q&A section is where the interesting stuff happens. Readers ask hard questions — about practice, about doubt, about what to do when nothing seems to work.

Some questions already have answers. Some are still open — you can weigh in.

Sample question: "Is acceptance the same as giving up? Sometimes it feels like the same thing."

See the Q&A: ${SITE_URL}/community/

— N

---
${ctx.unsubscribeUrl ? `Unsubscribe: ${ctx.unsubscribeUrl}` : ""}
    `.trim(),
  },

  5: {
    subject: "Join the conversation",
    buildHtml: (ctx) => buildHtml({
      ctx,
      preheader: "The community section is the most active part of the site.",
      heading: "People are talking.",
      body: `
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          ${ctx.firstName ? `Hey ${escapeHtml(ctx.firstName)},` : "Hey,"}
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          The community section is where readers share what's actually going on in their practice.
          Not theory. Real experience.
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          The most active threads right now are worth a few minutes.
        </p>
        <div style="text-align:center;margin:36px 0;">
          <a href="${SITE_URL}/community/"
             style="display:inline-block;padding:14px 32px;background-color:#7d8c6e;color:#fff;font-family:system-ui,-apple-system,sans-serif;font-size:15px;font-weight:600;text-decoration:none;border-radius:4px;letter-spacing:0.02em;">
            Visit the Community
          </a>
        </div>
        <p style="margin:0;font-size:16px;line-height:1.7;color:#555;">
          — N
        </p>
      `,
    }),
    buildText: (ctx) => `
${ctx.firstName ? `Hey ${ctx.firstName},` : "Hey,"}

The community section is where readers share what's actually going on in their practice. Not theory. Real experience.

The most active threads right now are worth a few minutes.

Visit the community: ${SITE_URL}/community/

— N

---
${ctx.unsubscribeUrl ? `Unsubscribe: ${ctx.unsubscribeUrl}` : ""}
    `.trim(),
  },

  7: {
    subject: "Your reading streak starts now",
    buildHtml: (ctx) => buildHtml({
      ctx,
      preheader: "A week in. Here's how to keep the momentum.",
      heading: "One week in.",
      body: `
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          ${ctx.firstName ? `Hey ${escapeHtml(ctx.firstName)},` : "Hey,"}
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          You've been here a week. That's how it starts — not with a big commitment,
          just by showing up.
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          The site tracks reading streaks. Every essay you finish counts.
          Check your profile to see where you stand.
        </p>
        <div style="text-align:center;margin:36px 0;">
          <a href="${SITE_URL}/reading/"
             style="display:inline-block;padding:14px 32px;background-color:#7d8c6e;color:#fff;font-family:system-ui,-apple-system,sans-serif;font-size:15px;font-weight:600;text-decoration:none;border-radius:4px;letter-spacing:0.02em;">
            View Your Reading
          </a>
        </div>
        <p style="margin:0 0 20px;font-size:16px;line-height:1.7;color:#555;">
          Keep going. — N
        </p>
      `,
    }),
    buildText: (ctx) => `
${ctx.firstName ? `Hey ${ctx.firstName},` : "Hey,"}

You've been here a week. That's how it starts — not with a big commitment, just by showing up.

The site tracks reading streaks. Every essay you finish counts. Check your profile to see where you stand:
${SITE_URL}/reading/

Keep going. — N

---
${ctx.unsubscribeUrl ? `Unsubscribe: ${ctx.unsubscribeUrl}` : ""}
    `.trim(),
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface Subscriber {
  email: string;
  first_name: string | null;
  created_at: string;
}

interface SendResult {
  email: string;
  step: Step;
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
      console.error("onboarding-sequence: unauthorized request");
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  // Graceful skip: Resend key not yet provisioned
  if (!RESEND_API_KEY) {
    console.log("onboarding-sequence: RESEND_API_KEY not set — skipping (will activate on provision)");
    return res.status(200).json({ skipped: true, reason: "RESEND_API_KEY not set" });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("onboarding-sequence: Supabase env vars not set");
    return res.status(500).json({ error: "Supabase not configured" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const resend = new Resend(RESEND_API_KEY);
  const results: SendResult[] = [];
  const errors: string[] = [];

  for (const step of STEPS) {
    try {
      const sent = await processStep(step, supabase, resend);
      results.push(...sent);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`onboarding-sequence: step ${step} failed:`, msg);
      errors.push(`step ${step}: ${msg}`);
    }
  }

  const totalSent = results.filter((r) => !r.error).length;
  const totalFailed = results.filter((r) => r.error).length;

  console.log(
    `onboarding-sequence: done — sent=${totalSent} failed=${totalFailed} errors=${errors.length}`
  );

  return res.status(200).json({
    sent: totalSent,
    failed: totalFailed,
    results,
    errors,
  });
}

// ─── Step processor ───────────────────────────────────────────────────────────

async function processStep(
  step: Step,
  supabase: SupabaseClient,
  resend: Resend
): Promise<SendResult[]> {
  // Find subscribers whose created_at falls in the window for this step.
  // Window: [now - (step+1) days, now - step days] — catches subscribers
  // who subscribed exactly `step` days ago (±24h window).
  const now = new Date();
  const windowEnd = new Date(now.getTime() - step * 24 * 60 * 60 * 1000);
  const windowStart = new Date(now.getTime() - (step + 1) * 24 * 60 * 60 * 1000);

  // Fetch active subscribers in the window
  const { data: subscribers, error: fetchError } = await supabase
    .from("subscribers")
    .select("email, first_name, created_at")
    .eq("status", "active")
    .gte("created_at", windowStart.toISOString())
    .lt("created_at", windowEnd.toISOString());

  if (fetchError) {
    throw new Error(`fetch subscribers for step ${step}: ${fetchError.message}`);
  }

  if (!subscribers || subscribers.length === 0) {
    console.log(`onboarding-sequence: step ${step} — no subscribers in window`);
    return [];
  }

  // Exclude subscribers who have already received this step (idempotency)
  const emails = subscribers.map((s: Subscriber) => s.email);
  const { data: alreadySent, error: checkError } = await supabase
    .from("onboarding_sequences")
    .select("subscriber_id")
    .eq("step", step)
    .in("subscriber_id", emails);

  if (checkError) {
    throw new Error(`check sent for step ${step}: ${checkError.message}`);
  }

  const sentEmails = new Set((alreadySent ?? []).map((r: { subscriber_id: string }) => r.subscriber_id));
  const pending = (subscribers as Subscriber[]).filter((s) => !sentEmails.has(s.email));

  if (pending.length === 0) {
    console.log(`onboarding-sequence: step ${step} — all ${subscribers.length} already sent`);
    return [];
  }

  // Exclude subscribers who have opted out of email
  const { data: optedOut, error: prefError } = await supabase
    .from("subscriber_preferences")
    .select("subscriber_id")
    .in("subscriber_id", pending.map((s) => s.email))
    .eq("newsletter", false);

  if (prefError) {
    // Log but don't fail — missing prefs row means opted-in (default true)
    console.warn(`onboarding-sequence: step ${step} — prefs check warning: ${prefError.message}`);
  }

  const optedOutEmails = new Set((optedOut ?? []).map((r: { subscriber_id: string }) => r.subscriber_id));
  const toSend = pending.filter((s) => !optedOutEmails.has(s.email));

  console.log(
    `onboarding-sequence: step ${step} — window=[${windowStart.toISOString()}, ${windowEnd.toISOString()}] ` +
    `candidates=${subscribers.length} already_sent=${sentEmails.size} opted_out=${optedOutEmails.size} to_send=${toSend.length}`
  );

  const results: SendResult[] = [];

  for (const subscriber of toSend) {
    const result = await sendStepEmail(step, subscriber, resend, supabase);
    results.push(result);
  }

  return results;
}

// ─── Email sender ─────────────────────────────────────────────────────────────

async function sendStepEmail(
  step: Step,
  subscriber: Subscriber,
  resend: Resend,
  supabase: SupabaseClient
): Promise<SendResult> {
  const config = stepConfigs[step];
  const unsubscribeUrl = `${SITE_URL}/unsubscribe?email=${encodeURIComponent(subscriber.email)}`;
  const ctx: EmailContext = {
    firstName: subscriber.first_name,
    email: subscriber.email,
    unsubscribeUrl,
  };

  let resendEmailId: string | null = null;
  let sendError: string | null = null;

  try {
    const { data, error } = await resend.emails.send({
      from: EMAIL_FROM,
      to: subscriber.email,
      ...(EMAIL_REPLY_TO ? { replyTo: EMAIL_REPLY_TO } : {}),
      subject: config.subject,
      html: config.buildHtml(ctx),
      text: config.buildText(ctx),
      // Tag for open tracking via webhook (OLU-345)
      tags: [
        { name: "sequence", value: "onboarding" },
        { name: "step", value: String(step) },
      ],
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });

    if (error) {
      throw new Error(error.message);
    }

    resendEmailId = data?.id ?? null;

    // Record in onboarding_sequences (upsert for safety — unique constraint handles dupe prevention)
    const { error: insertError } = await supabase
      .from("onboarding_sequences")
      .upsert(
        {
          subscriber_id: subscriber.email,
          step,
          resend_email_id: resendEmailId,
          sent_at: new Date().toISOString(),
        },
        { onConflict: "subscriber_id,step", ignoreDuplicates: true }
      );

    if (insertError) {
      // Log but don't treat as send failure — email was sent
      console.error(
        `onboarding-sequence: step ${step} ${subscriber.email} — DB insert error: ${insertError.message}`
      );
    }

    console.log(
      `onboarding-sequence: step ${step} sent to ${subscriber.email} — resend_id=${resendEmailId}`
    );
  } catch (err: unknown) {
    sendError = err instanceof Error ? err.message : String(err);
    console.error(
      `onboarding-sequence: step ${step} failed for ${subscriber.email}: ${sendError}`
    );
  }

  return { email: subscriber.email, step, resendEmailId, error: sendError };
}

// ─── Email template ───────────────────────────────────────────────────────────

function buildHtml({
  ctx,
  preheader,
  heading,
  body,
}: {
  ctx: EmailContext;
  preheader: string;
  heading: string;
  body: string;
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
                <a href="${escapeHtml(ctx.unsubscribeUrl)}" style="color:#bbb;">Unsubscribe</a>
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
