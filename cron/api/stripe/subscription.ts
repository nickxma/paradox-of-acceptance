/**
 * GET /api/stripe/subscription?wallet=0x...
 *
 * Returns whether a wallet address has an active Stripe subscription.
 * Used by the frontend to check fiat-based access alongside on-chain token check.
 *
 * Required env vars:
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

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
    .select("status, current_period_end")
    .eq("wallet_address", wallet.toLowerCase())
    .single();

  if (error && error.code !== "PGRST116") {
    // PGRST116 = no rows found, which is fine
    console.error("subscription-status: db error:", error.message);
    return res.status(500).json({ error: "Database error" });
  }

  if (!data) {
    return res.status(200).json({ isSubscriber: false });
  }

  const isActive =
    data.status === "active" &&
    (data.current_period_end === null || new Date(data.current_period_end) > new Date());

  return res.status(200).json({ isSubscriber: isActive });
}
