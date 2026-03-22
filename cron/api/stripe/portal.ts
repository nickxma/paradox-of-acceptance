/**
 * POST /api/stripe/portal
 *
 * Creates a Stripe Billing Portal Session for an authenticated wallet address
 * that has an active Stripe subscription.
 *
 * Request body: { walletAddress: string }
 * Returns: { url: string }
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY         — Stripe secret key
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 *   SITE_URL                  — Base URL for portal return redirect (optional)
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
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

  if (!STRIPE_SECRET_KEY) {
    console.error("portal: missing STRIPE_SECRET_KEY");
    return res.status(500).json({ error: "Stripe not configured" });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("portal: missing Supabase env vars");
    return res.status(500).json({ error: "Database not configured" });
  }

  const { walletAddress } = req.body as { walletAddress?: string };
  if (!walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: "Valid walletAddress required" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Look up the stripe_customer_id for this wallet
  const { data, error } = await supabase
    .from("subscriptions")
    .select("stripe_customer_id, status")
    .eq("wallet_address", walletAddress.toLowerCase())
    .single();

  if (error && error.code !== "PGRST116") {
    console.error("portal: db error:", error.message);
    return res.status(500).json({ error: "Database error" });
  }

  if (!data || !data.stripe_customer_id) {
    return res.status(404).json({ error: "No Stripe subscription found for this wallet" });
  }

  if (data.status !== "active") {
    return res.status(403).json({ error: "No active subscription" });
  }

  try {
    const stripe = new Stripe(STRIPE_SECRET_KEY);

    const session = await stripe.billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      return_url: `${SITE_URL}/pass/?subscription_updated=1`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("portal: stripe error:", message);
    return res.status(500).json({ error: "Failed to create portal session" });
  }
}
