/**
 * POST /api/webhooks/stripe
 *
 * Handles Stripe webhook events. Verifies HMAC signature before processing.
 *
 * Handled events:
 *   checkout.session.completed     — grant access (upsert subscriptions row)
 *   customer.subscription.deleted  — revoke access (set status = 'cancelled')
 *   customer.subscription.updated  — sync status and period end
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY       — Stripe secret key
 *   STRIPE_WEBHOOK_SECRET   — Stripe webhook signing secret (whsec_...)
 *   SUPABASE_URL            — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

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

  // Supabase client (service role — bypasses RLS)
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("stripe-webhook: missing Supabase env vars");
    return res.status(500).json({ error: "Database not configured" });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const walletAddress = session.metadata?.walletAddress;

        if (!walletAddress) {
          console.warn("stripe-webhook: checkout.session.completed has no walletAddress in metadata");
          break;
        }

        // Fetch the subscription to get period end
        let currentPeriodEnd: string | null = null;
        let stripeSubscriptionId: string | null = null;
        let stripeCustomerId: string | null = null;

        if (session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription as string);
          stripeSubscriptionId = sub.id;
          stripeCustomerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
          currentPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();
        }

        const { error } = await supabase.from("subscriptions").upsert(
          {
            wallet_address: walletAddress,
            stripe_customer_id: stripeCustomerId,
            stripe_subscription_id: stripeSubscriptionId,
            status: "active",
            current_period_end: currentPeriodEnd,
          },
          { onConflict: "wallet_address" }
        );

        if (error) {
          console.error("stripe-webhook: upsert failed:", error.message);
          return res.status(500).json({ error: "Database write failed" });
        }

        console.log(`stripe-webhook: granted access to ${walletAddress}`);
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const stripeSubscriptionId = sub.id;

        const { error } = await supabase
          .from("subscriptions")
          .update({ status: "cancelled", current_period_end: new Date(sub.current_period_end * 1000).toISOString() })
          .eq("stripe_subscription_id", stripeSubscriptionId);

        if (error) {
          console.error("stripe-webhook: revoke failed:", error.message);
          return res.status(500).json({ error: "Database write failed" });
        }

        console.log(`stripe-webhook: revoked access for sub ${stripeSubscriptionId}`);
        break;
      }

      case "customer.subscription.updated": {
        const sub = event.data.object as Stripe.Subscription;
        const stripeSubscriptionId = sub.id;
        const status = sub.status === "active" ? "active" : sub.status === "past_due" ? "past_due" : "cancelled";
        const currentPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();

        const { error } = await supabase
          .from("subscriptions")
          .update({ status, current_period_end: currentPeriodEnd })
          .eq("stripe_subscription_id", stripeSubscriptionId);

        if (error) {
          console.error("stripe-webhook: update failed:", error.message);
          return res.status(500).json({ error: "Database write failed" });
        }

        console.log(`stripe-webhook: updated sub ${stripeSubscriptionId} → status=${status}`);
        break;
      }

      default:
        // Ignore unhandled event types
        break;
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("stripe-webhook: handler error:", message);
    return res.status(500).json({ error: "Webhook processing failed" });
  }

  return res.status(200).json({ received: true });
}
