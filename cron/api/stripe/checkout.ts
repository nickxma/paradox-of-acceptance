/**
 * POST /api/stripe/checkout
 *
 * Creates a Stripe Checkout Session for a wallet address.
 * The wallet_address is stored in session metadata so the webhook
 * can associate the subscription with the right user.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY   — Stripe secret key (sk_live_... or sk_test_...)
 *   STRIPE_PRICE_ID     — Stripe price ID for the monthly subscription product
 *   SITE_URL            — Base URL for success/cancel redirects (optional, defaults to prod)
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID ?? "";
const SITE_URL = process.env.SITE_URL ?? "https://paradoxofacceptance.xyz";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "https://paradoxofacceptance.xyz";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ID) {
    console.error("checkout: missing STRIPE_SECRET_KEY or STRIPE_PRICE_ID");
    return res.status(500).json({ error: "Stripe not configured" });
  }

  const { walletAddress, promoCode, refCode } = req.body as {
    walletAddress?: string;
    promoCode?: string;
    refCode?: string;
  };
  if (!walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: "Valid walletAddress required" });
  }

  try {
    const stripe = new Stripe(STRIPE_SECRET_KEY);

    // Validate promo code if provided
    let promotionCodeId: string | null = null;
    if (promoCode && promoCode.trim().length > 0) {
      const result = await stripe.promotionCodes.list({
        code: promoCode.trim(),
        active: true,
        limit: 1,
      });
      const matched = result.data[0];
      if (!matched) {
        return res.status(400).json({ error: "invalid_promo_code" });
      }
      promotionCodeId = matched.id;
    }

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      metadata: {
        walletAddress: walletAddress.toLowerCase(),
        ...(refCode && /^[A-Z0-9]{8}$/.test(refCode.trim().toUpperCase())
          ? { refCode: refCode.trim().toUpperCase() }
          : {}),
      },
      subscription_data: { trial_period_days: 14 },
      success_url: `${SITE_URL}/access/success/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/pass/`,
    };

    if (promotionCodeId) {
      // Explicit promo code: apply discount directly
      sessionParams.discounts = [{ promotion_code: promotionCodeId }];
    } else {
      // No promo code: let Stripe show their built-in promo input
      sessionParams.allow_promotion_codes = true;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return res.status(200).json({ url: session.url });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("checkout: stripe error:", message);
    return res.status(500).json({ error: "Failed to create checkout session" });
  }
}
