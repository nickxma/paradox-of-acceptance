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

        let trialEnd: string | null = null;
        let initialStatus: "active" | "trialing" = "active";

        if (session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription as string);
          stripeSubscriptionId = sub.id;
          stripeCustomerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
          const ts = sub.items.data[0]?.current_period_end;
          currentPeriodEnd = ts ? new Date(ts * 1000).toISOString() : null;
          if (sub.status === "trialing" && sub.trial_end) {
            trialEnd = new Date(sub.trial_end * 1000).toISOString();
            initialStatus = "trialing";
          }
        }

        // Extract promo code and discount amount from the session
        let promoCode: string | null = null;
        let discountAmountCents: number | null = null;
        const discounts = session.total_details?.breakdown?.discounts;
        if (discounts && discounts.length > 0) {
          const firstDiscount = discounts[0];
          discountAmountCents = firstDiscount.amount ?? null;
          // Resolve the promotion code string from the discount's coupon/promotion_code
          const promoRef = firstDiscount.discount?.promotion_code;
          if (promoRef) {
            if (typeof promoRef === "string") {
              try {
                const pc = await stripe.promotionCodes.retrieve(promoRef);
                promoCode = pc.code;
              } catch {
                // Non-fatal — analytics only
              }
            } else {
              promoCode = (promoRef as Stripe.PromotionCode).code ?? null;
            }
          }
        }

        const { error } = await supabase.from("subscriptions").upsert(
          {
            wallet_address: walletAddress,
            stripe_customer_id: stripeCustomerId,
            stripe_subscription_id: stripeSubscriptionId,
            status: initialStatus,
            current_period_end: currentPeriodEnd,
            trial_end: trialEnd,
            promo_code: promoCode,
            discount_amount_cents: discountAmountCents,
          },
          { onConflict: "wallet_address" }
        );

        if (error) {
          console.error("stripe-webhook: upsert failed:", error.message);
          return res.status(500).json({ error: "Database write failed" });
        }

        console.log(`stripe-webhook: granted access to ${walletAddress}`);

        // ── Referral program ────────────────────────────────────────────────
        // 1. Ensure the new subscriber has a referral code (generated lazily on first checkout)
        await ensureReferralCode(supabase, walletAddress);

        // 2. If they came via a referral link, record the conversion (pending credit)
        const refCode = session.metadata?.refCode;
        if (refCode) {
          const { data: referrerRow } = await supabase
            .from("referral_codes")
            .select("user_id")
            .eq("code", refCode)
            .single();

          if (referrerRow && referrerRow.user_id !== walletAddress) {
            const { error: convError } = await supabase
              .from("referral_conversions")
              .upsert(
                { code: refCode, referee_user_id: walletAddress },
                { onConflict: "referee_user_id", ignoreDuplicates: true }
              );
            if (convError) {
              console.error("stripe-webhook: failed to record referral conversion:", convError.message);
            } else {
              console.log(`stripe-webhook: referral conversion recorded — referee=${walletAddress} code=${refCode}`);
            }
          } else if (referrerRow?.user_id === walletAddress) {
            console.warn(`stripe-webhook: self-referral blocked — wallet=${walletAddress}`);
          } else {
            console.warn(`stripe-webhook: unknown refCode ${refCode} — skipping conversion`);
          }
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const stripeSubscriptionId = sub.id;

        const cancelledPeriodEndTs = sub.items.data[0]?.current_period_end;
        const { error } = await supabase
          .from("subscriptions")
          .update({
            status: "cancelled",
            current_period_end: cancelledPeriodEndTs
              ? new Date(cancelledPeriodEndTs * 1000).toISOString()
              : null,
          })
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
        const status =
          sub.status === "active" ? "active" :
          sub.status === "trialing" ? "trialing" :
          sub.status === "past_due" ? "past_due" : "cancelled";
        const updatedTs = sub.items.data[0]?.current_period_end;
        const currentPeriodEnd = updatedTs ? new Date(updatedTs * 1000).toISOString() : null;
        const trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;

        const { error } = await supabase
          .from("subscriptions")
          .update({ status, current_period_end: currentPeriodEnd, trial_end: trialEnd })
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

// ─── Referral helpers ─────────────────────────────────────────────────────────

/**
 * Generates a unique referral code for a wallet address if one doesn't already exist.
 * Non-fatal — logs errors but does not throw.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensureReferralCode(supabase: any, walletAddress: string): Promise<void> {
  const { data: existing } = await supabase
    .from("referral_codes")
    .select("id")
    .eq("user_id", walletAddress)
    .maybeSingle();

  if (existing) return; // already has a code

  const code = await generateUniqueReferralCode(supabase);
  if (!code) {
    console.error(`stripe-webhook: failed to generate referral code for ${walletAddress}`);
    return;
  }

  const { error } = await supabase
    .from("referral_codes")
    .upsert({ user_id: walletAddress, code }, { onConflict: "user_id", ignoreDuplicates: true });

  if (error) {
    console.error(`stripe-webhook: failed to insert referral code for ${walletAddress}:`, error.message);
  } else {
    console.log(`stripe-webhook: referral code ${code} assigned to ${walletAddress}`);
  }
}

/**
 * Generates a unique 8-character alphanumeric referral code with up to 5 retry attempts.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function generateUniqueReferralCode(supabase: any): Promise<string | null> {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let attempt = 0; attempt < 5; attempt++) {
    let code = "";
    for (let i = 0; i < 8; i++) {
      code += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
    }
    const { data } = await supabase
      .from("referral_codes")
      .select("id")
      .eq("code", code)
      .maybeSingle();
    if (!data) return code;
  }
  return null;
}
