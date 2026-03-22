/**
 * GET /api/stripe/subscription?wallet=0x...
 *
 * Returns whether a wallet address has an active Stripe subscription,
 * along with subscription details for display in the UI.
 *
 * Response: { isSubscriber, currentPeriodEnd, last4 }
 *   - currentPeriodEnd: ISO string of the next renewal date (null if not available)
 *   - last4: last 4 digits of the card on file (null if not available)
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY         — Stripe secret key
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "https://paradoxofacceptance.xyz";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const wallet = req.query.wallet;
  if (!wallet || typeof wallet !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return res.status(400).json({ error: "Valid wallet address required" });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Database not configured" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data, error } = await supabase
    .from("subscriptions")
    .select("status, current_period_end, grace_period_end, stripe_customer_id")
    .eq("wallet_address", wallet.toLowerCase())
    .single();

  if (error && error.code !== "PGRST116") {
    // PGRST116 = no rows found, which is fine
    console.error("subscription-status: db error:", error.message);
    return res.status(500).json({ error: "Database error" });
  }

  if (!data) {
    return res.status(200).json({ isSubscriber: false, currentPeriodEnd: null, last4: null });
  }

  const now = new Date();

  // Active: paid and within billing period
  const isPaidActive =
    data.status === "active" &&
    (data.current_period_end === null || new Date(data.current_period_end) > now);

  // Grace period: payment failed but within 7-day grace window
  const isInGracePeriod =
    data.status === "past_due" &&
    data.grace_period_end !== null &&
    new Date(data.grace_period_end) > now;

  const isActive = isPaidActive || isInGracePeriod;

  if (!isActive) {
    return res.status(200).json({ isSubscriber: false, currentPeriodEnd: null, last4: null });
  }

  // Fetch last 4 digits of card from Stripe (best-effort)
  let last4: string | null = null;
  if (STRIPE_SECRET_KEY && data.stripe_customer_id) {
    try {
      const stripe = new Stripe(STRIPE_SECRET_KEY);
      const paymentMethods = await stripe.customers.listPaymentMethods(data.stripe_customer_id, {
        type: "card",
        limit: 1,
      });
      if (paymentMethods.data.length > 0) {
        last4 = paymentMethods.data[0].card?.last4 ?? null;
      }
    } catch (err: unknown) {
      // Non-fatal — UI will just omit the card info
      const message = err instanceof Error ? err.message : String(err);
      console.warn("subscription-status: could not fetch card last4:", message);
    }
  }

  return res.status(200).json({
    isSubscriber: true,
    currentPeriodEnd: data.current_period_end,
    last4,
  });
}
