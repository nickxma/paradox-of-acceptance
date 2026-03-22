/**
 * POST /api/stripe/webhook
 *
 * Handles Stripe subscription lifecycle events. Verifies HMAC signature before processing.
 *
 * Handled events:
 *   customer.subscription.created   — update row to active when subscription is created
 *   customer.subscription.updated   — sync status and period end
 *   customer.subscription.deleted   — set status = 'cancelled' (downgrade to free)
 *   invoice.payment_failed          — set status = 'past_due', send payment failure email
 *   invoice.payment_succeeded       — set status = 'active', update period end
 *
 * Note: The initial subscription row (with wallet_address) is inserted by
 * POST /api/webhooks/stripe when handling checkout.session.completed. This
 * endpoint handles all subsequent lifecycle events on that row.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY         — Stripe secret key
 *   STRIPE_WEBHOOK_SECRET     — Stripe webhook signing secret (whsec_...)
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 *   RESEND_API_KEY            — Resend API key (for payment failure emails)
 *   EMAIL_FROM                — verified sender address
 *   SITE_URL                  — base URL for links in notification emails (optional)
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const RESEND_API_KEY = process.env.RESEND_API_KEY ?? "";
const EMAIL_FROM = process.env.EMAIL_FROM ?? "hello@paradoxofacceptance.xyz";
const SITE_URL = process.env.SITE_URL ?? "https://paradoxofacceptance.xyz";

// Vercel: must disable body parser to get raw bytes for HMAC verification
export const config = {
  api: { bodyParser: false },
};

async function getRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
    console.error("stripe-webhook: missing Stripe env vars");
    return res.status(500).json({ error: "Stripe not configured" });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);

  // Verify Stripe signature (HMAC)
  const rawBody = await getRawBody(req);
  const sig = req.headers["stripe-signature"];

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig as string, STRIPE_WEBHOOK_SECRET);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("stripe-webhook: signature verification failed:", message);
    return res.status(401).json({ error: "Invalid signature" });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("stripe-webhook: missing Supabase env vars");
    return res.status(500).json({ error: "Database not configured" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  console.log(`stripe-webhook: event type=${event.type} id=${event.id}`);

  try {
    switch (event.type) {
      case "customer.subscription.created": {
        // The subscription row was already inserted by checkout.session.completed.
        // Update it with the confirmed status and period end from the subscription object.
        const sub = event.data.object as Stripe.Subscription;
        const stripeCustomerId =
          typeof sub.customer === "string" ? sub.customer : sub.customer.id;
        const status = mapStripeStatus(sub.status);
        // In Stripe SDK v20+, current_period_end is on each SubscriptionItem, not the Subscription root
        const periodEndTs = sub.items.data[0]?.current_period_end;
        const currentPeriodEnd = periodEndTs
          ? new Date(periodEndTs * 1000).toISOString()
          : null;

        const { error } = await supabase
          .from("subscriptions")
          .update({ stripe_customer_id: stripeCustomerId, status, current_period_end: currentPeriodEnd })
          .eq("stripe_subscription_id", sub.id);

        if (error) {
          console.error("stripe-webhook: subscription.created update failed:", error.message);
          return res.status(500).json({ error: "Database write failed" });
        }

        console.log(`stripe-webhook: subscription.created sub=${sub.id} status=${status}`);
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const status = mapStripeStatus(sub.status);
        const updatedPeriodEndTs = sub.items.data[0]?.current_period_end;
        const currentPeriodEnd = updatedPeriodEndTs
          ? new Date(updatedPeriodEndTs * 1000).toISOString()
          : null;

        const { error } = await supabase
          .from("subscriptions")
          .update({ status, current_period_end: currentPeriodEnd })
          .eq("stripe_subscription_id", sub.id);

        if (error) {
          console.error("stripe-webhook: subscription.updated failed:", error.message);
          return res.status(500).json({ error: "Database write failed" });
        }

        console.log(`stripe-webhook: subscription.updated sub=${sub.id} status=${status}`);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const deletedPeriodEndTs = sub.items.data[0]?.current_period_end;
        const currentPeriodEnd = deletedPeriodEndTs
          ? new Date(deletedPeriodEndTs * 1000).toISOString()
          : null;

        const { error } = await supabase
          .from("subscriptions")
          .update({ status: "cancelled", current_period_end: currentPeriodEnd })
          .eq("stripe_subscription_id", sub.id);

        if (error) {
          console.error("stripe-webhook: subscription.deleted failed:", error.message);
          return res.status(500).json({ error: "Database write failed" });
        }

        console.log(`stripe-webhook: subscription.deleted sub=${sub.id} — downgraded to free`);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        // In Stripe SDK v20+, subscription lives under invoice.parent.subscription_details.subscription
        const subRef = invoice.parent?.subscription_details?.subscription ?? null;
        const stripeSubscriptionId =
          subRef == null ? null : typeof subRef === "string" ? subRef : subRef.id;

        if (!stripeSubscriptionId) {
          console.warn("stripe-webhook: invoice.payment_failed missing subscription ID — skipping");
          break;
        }

        // Set subscription to past_due
        const { error } = await supabase
          .from("subscriptions")
          .update({ status: "past_due" })
          .eq("stripe_subscription_id", stripeSubscriptionId);

        if (error) {
          console.error("stripe-webhook: invoice.payment_failed update failed:", error.message);
          return res.status(500).json({ error: "Database write failed" });
        }

        // Send payment failure notification (non-fatal if it fails)
        const customerEmail = invoice.customer_email;
        if (customerEmail && RESEND_API_KEY) {
          try {
            const resend = new Resend(RESEND_API_KEY);
            await resend.emails.send({
              from: EMAIL_FROM,
              to: customerEmail,
              subject: "Payment failed — update your payment method",
              html: buildPaymentFailedEmail(SITE_URL),
            });
            console.log(`stripe-webhook: payment failure email sent to ${customerEmail}`);
          } catch (emailErr: unknown) {
            const message = emailErr instanceof Error ? emailErr.message : String(emailErr);
            console.error("stripe-webhook: failed to send payment failure email:", message);
          }
        } else if (!customerEmail) {
          console.warn("stripe-webhook: invoice.payment_failed — no customer_email, skipping notification");
        } else {
          console.warn("stripe-webhook: RESEND_API_KEY not set — skipping payment failure email");
        }

        console.log(`stripe-webhook: invoice.payment_failed sub=${stripeSubscriptionId} set to past_due`);
        break;
      }

      case "invoice.payment_succeeded": {
        const invoice = event.data.object as Stripe.Invoice;
        // In Stripe SDK v20+, subscription lives under invoice.parent.subscription_details.subscription
        const succeededSubRef = invoice.parent?.subscription_details?.subscription ?? null;
        const stripeSubscriptionId =
          succeededSubRef == null
            ? null
            : typeof succeededSubRef === "string"
            ? succeededSubRef
            : succeededSubRef.id;

        if (!stripeSubscriptionId) {
          console.warn("stripe-webhook: invoice.payment_succeeded missing subscription ID — skipping");
          break;
        }

        // Fetch the subscription to get the updated period end
        let currentPeriodEnd: string | null = null;
        try {
          const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
          const ts = sub.items.data[0]?.current_period_end;
          currentPeriodEnd = ts ? new Date(ts * 1000).toISOString() : null;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.warn("stripe-webhook: could not fetch subscription for period end:", message);
        }

        const updateData: Record<string, unknown> = { status: "active" };
        if (currentPeriodEnd) updateData.current_period_end = currentPeriodEnd;

        const { error } = await supabase
          .from("subscriptions")
          .update(updateData)
          .eq("stripe_subscription_id", stripeSubscriptionId);

        if (error) {
          console.error("stripe-webhook: invoice.payment_succeeded update failed:", error.message);
          return res.status(500).json({ error: "Database write failed" });
        }

        console.log(`stripe-webhook: invoice.payment_succeeded sub=${stripeSubscriptionId} confirmed active`);
        break;
      }

      default:
        console.log(`stripe-webhook: ignoring unhandled event type=${event.type}`);
        break;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("stripe-webhook: handler error:", message);
    return res.status(500).json({ error: "Webhook processing failed" });
  }

  return res.status(200).json({ received: true });
}

/**
 * Maps Stripe subscription status to our DB status enum.
 * DB allows: 'active' | 'cancelled' | 'past_due'
 */
function mapStripeStatus(
  stripeStatus: Stripe.Subscription.Status
): "active" | "cancelled" | "past_due" {
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    default:
      return "cancelled";
  }
}

/**
 * Builds the HTML body for a payment failure notification email.
 */
function buildPaymentFailedEmail(siteUrl: string): string {
  const portalUrl = `${siteUrl}/pass/`;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #1a1a1a; background: #fff;">
  <h2 style="font-size: 22px; font-weight: normal; margin-bottom: 24px;">Payment failed</h2>
  <p style="line-height: 1.7; margin-bottom: 16px;">
    We couldn't process your payment for your Paradox of Acceptance membership.
    Your access remains active for now, but your subscription will be cancelled
    if payment continues to fail.
  </p>
  <p style="line-height: 1.7; margin-bottom: 24px;">
    Please update your payment method to keep your access uninterrupted.
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
