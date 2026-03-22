/**
 * GET /api/cron/dunning
 *
 * Vercel cron job — runs daily at 12:00 UTC.
 *
 * Processes the dunning_emails queue for past_due subscriptions:
 *
 *   day 3 — sends "4 days left" reminder email
 *   day 7 — sends "access revoked" final notice AND downgrades subscription to free
 *
 * If the subscription is no longer past_due (payment recovered), pending emails
 * are cancelled instead of sent.
 *
 * Email sends are gated on RESEND_API_KEY so the downgrade logic ships independently.
 *
 * Schedule: 0 12 * * * (see vercel.json — 12:00 UTC)
 *
 * Required env vars:
 *   CRON_SECRET               — Vercel auto-injects; set in Vercel dashboard too
 *   RESEND_API_KEY            — Resend API key (optional — gates email sends only)
 *   EMAIL_FROM                — verified sender address
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 *   SITE_URL                  — base URL for links in emails (optional)
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { Resend } from "resend";

// ─── Config ───────────────────────────────────────────────────────────────────

const CRON_SECRET = process.env.CRON_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM ?? "hello@paradoxofacceptance.xyz";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const SITE_URL = process.env.SITE_URL ?? "https://paradoxofacceptance.xyz";

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify Vercel cron secret
  if (CRON_SECRET) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("dunning: missing Supabase env vars");
    return res.status(500).json({ error: "Database not configured" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
  const now = new Date().toISOString();

  // Fetch all pending dunning emails whose scheduled_at has passed
  const { data: rows, error: fetchError } = await supabase
    .from("dunning_emails")
    .select("id, stripe_subscription_id, customer_email, day, scheduled_at")
    .eq("status", "pending")
    .lte("scheduled_at", now);

  if (fetchError) {
    console.error("dunning: failed to fetch pending dunning emails:", fetchError.message);
    return res.status(500).json({ error: "Database error" });
  }

  if (!rows || rows.length === 0) {
    console.log("dunning: no pending dunning emails due");
    return res.status(200).json({ processed: 0 });
  }

  console.log(`dunning: processing ${rows.length} pending dunning email(s)`);

  let sent = 0;
  let cancelled = 0;
  let downgraded = 0;

  for (const row of rows) {
    const { id, stripe_subscription_id, customer_email, day } = row;

    // Check current subscription status
    const { data: sub, error: subError } = await supabase
      .from("subscriptions")
      .select("status, grace_period_end")
      .eq("stripe_subscription_id", stripe_subscription_id)
      .single();

    if (subError || !sub) {
      console.warn(`dunning: subscription not found for sub=${stripe_subscription_id}, skipping`);
      continue;
    }

    // If subscription has recovered, cancel this and remaining pending emails
    if (sub.status !== "past_due") {
      await supabase
        .from("dunning_emails")
        .update({ status: "cancelled" })
        .eq("id", id);
      console.log(`dunning: sub=${stripe_subscription_id} recovered — cancelled day-${day} email`);
      cancelled++;
      continue;
    }

    // Day 7: downgrade to free regardless of whether email sends succeed
    if (day === 7) {
      const { error: downgradeError } = await supabase
        .from("subscriptions")
        .update({ status: "cancelled", grace_period_end: null })
        .eq("stripe_subscription_id", stripe_subscription_id)
        .eq("status", "past_due"); // guard: only downgrade if still past_due

      if (downgradeError) {
        console.error(
          `dunning: failed to downgrade sub=${stripe_subscription_id}:`,
          downgradeError.message
        );
        // Do not send email if DB write failed — will retry next run
        continue;
      }

      console.log(`dunning: sub=${stripe_subscription_id} grace period expired — downgraded to free`);
      downgraded++;
    }

    // Send email (gated on RESEND_API_KEY)
    if (resend) {
      try {
        const subject =
          day === 3
            ? "Payment reminder — 4 days left to update your payment method"
            : "Your Paradox of Acceptance access has been paused";

        await resend.emails.send({
          from: EMAIL_FROM,
          to: customer_email,
          subject,
          html: buildDunningEmail(SITE_URL, day as 3 | 7),
        });

        await supabase
          .from("dunning_emails")
          .update({ status: "sent", sent_at: new Date().toISOString() })
          .eq("id", id);

        console.log(`dunning: day-${day} email sent to ${customer_email} sub=${stripe_subscription_id}`);
        sent++;
      } catch (emailErr: unknown) {
        const message = emailErr instanceof Error ? emailErr.message : String(emailErr);
        console.error(
          `dunning: failed to send day-${day} email to ${customer_email}:`,
          message
        );
        // Leave as pending — will retry next run (only day 7 downgrade already written)
      }
    } else {
      // No Resend configured — mark as cancelled (not pending) so we don't retry forever
      await supabase
        .from("dunning_emails")
        .update({ status: "cancelled" })
        .eq("id", id);
      console.warn(
        `dunning: RESEND_API_KEY not set — day-${day} email for sub=${stripe_subscription_id} skipped`
      );
      cancelled++;
    }
  }

  console.log(`dunning: done — sent=${sent} cancelled=${cancelled} downgraded=${downgraded}`);
  return res.status(200).json({ processed: rows.length, sent, cancelled, downgraded });
}

// ─── Email builders ───────────────────────────────────────────────────────────

function buildDunningEmail(siteUrl: string, day: 3 | 7): string {
  const portalUrl = `${siteUrl}/pass/`;

  if (day === 7) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #1a1a1a; background: #fff;">
  <h2 style="font-size: 22px; font-weight: normal; margin-bottom: 24px;">Your access has been paused</h2>
  <p style="line-height: 1.7; margin-bottom: 16px;">
    We were unable to collect payment after several attempts, so your Paradox of Acceptance
    membership has been paused. Your reading history and account are still here.
  </p>
  <p style="line-height: 1.7; margin-bottom: 24px;">
    To restore access, please update your payment method.
  </p>
  <p style="margin-bottom: 32px;">
    <a href="${portalUrl}"
       style="display: inline-block; padding: 12px 24px; background: #1a1a1a; color: #fff; text-decoration: none; font-size: 14px;">
      Restore access &rarr;
    </a>
  </p>
  <p style="font-size: 13px; color: #666; line-height: 1.6;">
    If you have questions, reply to this email and we'll help you sort it out.
  </p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
  <p style="font-size: 12px; color: #999;">
    Paradox of Acceptance &middot; <a href="${siteUrl}/privacy/" style="color: #999;">Privacy</a>
  </p>
</body>
</html>`;
  }

  // day === 3
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #1a1a1a; background: #fff;">
  <h2 style="font-size: 22px; font-weight: normal; margin-bottom: 24px;">Payment still outstanding — 4 days left</h2>
  <p style="line-height: 1.7; margin-bottom: 16px;">
    Your payment for Paradox of Acceptance hasn't come through yet.
    You still have 4 days of access remaining — please update your payment method before then.
  </p>
  <p style="margin-bottom: 32px;">
    <a href="${portalUrl}"
       style="display: inline-block; padding: 12px 24px; background: #1a1a1a; color: #fff; text-decoration: none; font-size: 14px;">
      Update payment method &rarr;
    </a>
  </p>
  <p style="font-size: 13px; color: #666; line-height: 1.6;">
    If you have questions, reply to this email and we'll help you sort it out.
  </p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
  <p style="font-size: 12px; color: #999;">
    Paradox of Acceptance &middot; <a href="${siteUrl}/privacy/" style="color: #999;">Privacy</a>
  </p>
</body>
</html>`;
}
