/**
 * /api/cron/newsletter-sequence
 *
 * Vercel cron job — runs daily at 9am CT (14:00 UTC).
 * For each active newsletter subscriber, sends the appropriate welcome step
 * based on how many days have passed since they subscribed.
 *
 * Audience: people who subscribed via the website and may never have
 * created an app account. Distinct from the in-app onboarding sequence
 * (OLU-411, /api/cron/onboarding-sequence).
 *
 * Sequence:
 *   Step 0 (day 0)  — Welcome + paradox-of-acceptance thesis + starter essay link
 *   Step 3 (day 3)  — Contemplative practice prompt + Q&A engine invite
 *   Step 7 (day 7)  — Create account + join community + social proof
 *
 * Idempotency: unique constraint on (subscriber_id, step) in
 * subscriber_sequence_progress prevents duplicate sends.
 *
 * Skips subscribers who have unsubscribed or turned off email preferences.
 * Graceful no-op if RESEND_API_KEY is not set (activates automatically on provision).
 *
 * Open tracking: emails are tagged so the Resend webhook
 * (/api/webhooks/resend) can update subscriber_sequence_progress.opened_at.
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

const STEPS = [0, 3, 7] as const;
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
  0: {
    subject: "Welcome to Paradox of Acceptance",
    buildHtml: (ctx) =>
      buildHtml({
        ctx,
        preheader:
          "You subscribed. Here's what this is — and where to start.",
        heading: "Welcome.",
        body: `
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          ${ctx.firstName ? `Hey ${escapeHtml(ctx.firstName)},` : "Hey,"}
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          I'm Nick. Paradox of Acceptance is a writing project about a single idea:
          that resistance to your experience makes it worse, and that the act of
          fully accepting what is — not approving of it, not surrendering to it,
          just letting it be real — is what allows it to shift.
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          That sounds simple. It isn't. Most of the essays here are about the ways
          it fails — the subtle loops, the exceptions, the times when acceptance
          itself becomes a form of avoidance.
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          If you want to start somewhere, the essay below is the one most readers
          come back to.
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
    buildText: (ctx) =>
      `
${ctx.firstName ? `Hey ${ctx.firstName},` : "Hey,"}

I'm Nick. Paradox of Acceptance is a writing project about a single idea: that resistance to your experience makes it worse, and that the act of fully accepting what is — not approving of it, not surrendering to it, just letting it be real — is what allows it to shift.

That sounds simple. It isn't. Most of the essays here are about the ways it fails — the subtle loops, the exceptions, the times when acceptance itself becomes a form of avoidance.

If you want to start somewhere, the essay below is the one most readers come back to:
${SITE_URL}/mindfulness-essays/

More coming. — N

---
${ctx.unsubscribeUrl ? `Unsubscribe: ${ctx.unsubscribeUrl}` : ""}
    `.trim(),
  },

  3: {
    subject: "A practice prompt (and a question worth sitting with)",
    buildHtml: (ctx) =>
      buildHtml({
        ctx,
        preheader: "A short exercise, and a question the Q&A section is still chewing on.",
        heading: "Try this.",
        body: `
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          ${ctx.firstName ? `Hey ${escapeHtml(ctx.firstName)},` : "Hey,"}
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          Here's a practice from the recent essays: the next time you notice
          yourself bracing against something — a feeling, a situation, a thought —
          pause and name it out loud. Not to fix it. Just to make it real.
          <em>"I'm resisting this."</em>
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          That's it. Often that's enough to change the texture of it.
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          The Q&amp;A section is where readers bring their hard questions about
          practice. One that's currently open:
        </p>
        <div style="margin:28px 0;padding:24px;background-color:#f0ede6;border-left:3px solid #7d8c6e;">
          <p style="margin:0 0 8px;font-family:system-ui,-apple-system,sans-serif;font-size:14px;font-weight:600;color:#7d8c6e;text-transform:uppercase;letter-spacing:0.08em;">
            Open question
          </p>
          <p style="margin:0;font-size:17px;line-height:1.6;color:#2c2c2c;font-style:italic;">
            "How do you accept something when you're still furious about it?
            Isn't acceptance supposed to come after the anger, not during it?"
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
    buildText: (ctx) =>
      `
${ctx.firstName ? `Hey ${ctx.firstName},` : "Hey,"}

Here's a practice from the recent essays: the next time you notice yourself bracing against something — a feeling, a situation, a thought — pause and name it out loud. Not to fix it. Just to make it real. "I'm resisting this."

That's it. Often that's enough to change the texture of it.

The Q&A section is where readers bring their hard questions about practice. One that's currently open:

"How do you accept something when you're still furious about it? Isn't acceptance supposed to come after the anger, not during it?"

See the Q&A and weigh in: ${SITE_URL}/community/

— N

---
${ctx.unsubscribeUrl ? `Unsubscribe: ${ctx.unsubscribeUrl}` : ""}
    `.trim(),
  },

  7: {
    subject: "One week in — there's more here if you want it",
    buildHtml: (ctx) =>
      buildHtml({
        ctx,
        preheader:
          "The community is active. Here's how to get more out of the site.",
        heading: "One week in.",
        body: `
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          ${ctx.firstName ? `Hey ${escapeHtml(ctx.firstName)},` : "Hey,"}
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          You've been subscribed for a week. If you've been reading, thank you.
          If not, the essays will be here when you're ready.
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          There's a community section on the site where readers talk about their
          practice. A few hundred people are active there most weeks — sharing what
          they're working on, asking questions, occasionally changing each other's minds.
        </p>
        <p style="margin:0 0 20px;font-size:19px;line-height:1.7;color:#2c2c2c;">
          If you want to participate — post questions, track your reading, or just
          see what others are thinking — creating an account is free and takes
          about thirty seconds.
        </p>
        <div style="text-align:center;margin:36px 0;">
          <a href="${SITE_URL}/access/"
             style="display:inline-block;padding:14px 32px;background-color:#7d8c6e;color:#fff;font-family:system-ui,-apple-system,sans-serif;font-size:15px;font-weight:600;text-decoration:none;border-radius:4px;letter-spacing:0.02em;">
            Create a Free Account
          </a>
        </div>
        <p style="margin:0;font-size:16px;line-height:1.7;color:#555;">
          No obligation. The essays stay free regardless. — N
        </p>
      `,
      }),
    buildText: (ctx) =>
      `
${ctx.firstName ? `Hey ${ctx.firstName},` : "Hey,"}

You've been subscribed for a week. If you've been reading, thank you. If not, the essays will be here when you're ready.

There's a community section on the site where readers talk about their practice. A few hundred people are active there most weeks — sharing what they're working on, asking questions, occasionally changing each other's minds.

If you want to participate — post questions, track your reading, or just see what others are thinking — creating an account is free and takes about thirty seconds:
${SITE_URL}/access/

No obligation. The essays stay free regardless. — N

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
      console.error("newsletter-sequence: unauthorized request");
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  // Graceful skip: Resend key not yet provisioned
  if (!RESEND_API_KEY) {
    console.log(
      "newsletter-sequence: RESEND_API_KEY not set — skipping (will activate on provision)"
    );
    return res
      .status(200)
      .json({ skipped: true, reason: "RESEND_API_KEY not set" });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("newsletter-sequence: Supabase env vars not set");
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
      console.error(`newsletter-sequence: step ${step} failed:`, msg);
      errors.push(`step ${step}: ${msg}`);
    }
  }

  const totalSent = results.filter((r) => !r.error).length;
  const totalFailed = results.filter((r) => r.error).length;

  console.log(
    `newsletter-sequence: done — sent=${totalSent} failed=${totalFailed} errors=${errors.length}`
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
  // For step 0 (welcome): window = [now-1day, now]
  // For step N>0: window = [now-(N+1)days, now-N days]
  // This ensures each subscriber is eligible once per step within a 24h cron window.
  const now = new Date();
  const windowEnd =
    step === 0
      ? now
      : new Date(now.getTime() - step * 24 * 60 * 60 * 1000);
  const windowStart = new Date(
    now.getTime() - (step === 0 ? 1 : step + 1) * 24 * 60 * 60 * 1000
  );

  // Fetch active subscribers in the window
  const { data: subscribers, error: fetchError } = await supabase
    .from("subscribers")
    .select("email, first_name, created_at")
    .eq("status", "active")
    .gte("created_at", windowStart.toISOString())
    .lt("created_at", windowEnd.toISOString());

  if (fetchError) {
    throw new Error(
      `fetch subscribers for step ${step}: ${fetchError.message}`
    );
  }

  if (!subscribers || subscribers.length === 0) {
    console.log(`newsletter-sequence: step ${step} — no subscribers in window`);
    return [];
  }

  // Exclude subscribers who have already received this step (idempotency)
  const emails = subscribers.map((s: Subscriber) => s.email);
  const { data: alreadySent, error: checkError } = await supabase
    .from("subscriber_sequence_progress")
    .select("subscriber_id")
    .eq("step", step)
    .in("subscriber_id", emails);

  if (checkError) {
    throw new Error(`check sent for step ${step}: ${checkError.message}`);
  }

  const sentEmails = new Set(
    (alreadySent ?? []).map(
      (r: { subscriber_id: string }) => r.subscriber_id
    )
  );
  const pending = (subscribers as Subscriber[]).filter(
    (s) => !sentEmails.has(s.email)
  );

  if (pending.length === 0) {
    console.log(
      `newsletter-sequence: step ${step} — all ${subscribers.length} already sent`
    );
    return [];
  }

  // Exclude subscribers who have opted out of email
  const { data: optedOut, error: prefError } = await supabase
    .from("subscriber_preferences")
    .select("subscriber_id")
    .in(
      "subscriber_id",
      pending.map((s) => s.email)
    )
    .eq("newsletter", false);

  if (prefError) {
    // Log but don't fail — missing prefs row means opted-in (default true)
    console.warn(
      `newsletter-sequence: step ${step} — prefs check warning: ${prefError.message}`
    );
  }

  const optedOutEmails = new Set(
    (optedOut ?? []).map(
      (r: { subscriber_id: string }) => r.subscriber_id
    )
  );
  const toSend = pending.filter((s) => !optedOutEmails.has(s.email));

  console.log(
    `newsletter-sequence: step ${step} — ` +
      `window=[${windowStart.toISOString()}, ${windowEnd.toISOString()}] ` +
      `candidates=${subscribers.length} already_sent=${sentEmails.size} ` +
      `opted_out=${optedOutEmails.size} to_send=${toSend.length}`
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
  const emailType = `newsletter_step_${step}`;

  // Suppression check (defense in depth) — catches status changes between batch query and now
  const { data: subRow } = await supabase
    .from("subscribers")
    .select("status")
    .eq("email", subscriber.email)
    .single();

  if (subRow && subRow.status !== "active") {
    console.log(
      `newsletter-sequence: step ${step} skipping ${subscriber.email} — suppressed (status=${subRow.status})`
    );
    await logEmailSend(supabase, subscriber.email, emailType, "skipped", {
      skipReason: subRow.status,
    });
    return { email: subscriber.email, step, resendEmailId: null, error: null };
  }

  const config = stepConfigs[step];
  const unsubscribeUrl = `${SITE_URL}/unsubscribe?email=${encodeURIComponent(
    subscriber.email
  )}`;
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
      // Tag for open tracking via webhook
      tags: [
        { name: "sequence", value: "newsletter_welcome" },
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

    // Record in subscriber_sequence_progress (upsert for safety)
    const { error: insertError } = await supabase
      .from("subscriber_sequence_progress")
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
        `newsletter-sequence: step ${step} ${subscriber.email} — DB insert error: ${insertError.message}`
      );
    }

    console.log(
      `newsletter-sequence: step ${step} sent to ${subscriber.email} — resend_id=${resendEmailId}`
    );
    await logEmailSend(supabase, subscriber.email, emailType, "sent", {
      resendEmailId: resendEmailId ?? undefined,
    });
  } catch (err: unknown) {
    sendError = err instanceof Error ? err.message : String(err);
    console.error(
      `newsletter-sequence: step ${step} failed for ${subscriber.email}: ${sendError}`
    );
    await logEmailSend(supabase, subscriber.email, emailType, "failed");
  }

  return { email: subscriber.email, step, resendEmailId, error: sendError };
}

// ─── Logging ──────────────────────────────────────────────────────────────────

async function logEmailSend(
  supabase: SupabaseClient,
  email: string,
  type: string,
  status: "sent" | "skipped" | "failed",
  opts: { skipReason?: string; resendEmailId?: string } = {}
): Promise<void> {
  try {
    await supabase.from("email_send_log").insert({
      email,
      type,
      status,
      skip_reason: opts.skipReason ?? null,
      resend_email_id: opts.resendEmailId ?? null,
    });
  } catch {
    // Silently ignore logging errors — never block email sends
  }
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
