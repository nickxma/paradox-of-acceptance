/**
 * POST /api/subscriptions/cancel-survey
 *
 * Records a cancellation reason before the user proceeds to the Stripe portal.
 * Stores to the `churn_events` table in Supabase.
 *
 * Required Supabase table (run once):
 *   CREATE TABLE churn_events (
 *     id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *     wallet_address  text NOT NULL,
 *     reason          text NOT NULL,
 *     reason_detail   text,
 *     cancelled_at    timestamptz NOT NULL DEFAULT now()
 *   );
 *
 * Request body:
 *   {
 *     walletAddress: string,  — 0x-prefixed wallet address
 *     reason: string,         — one of: too_expensive | not_using | missing_feature | switching | pausing | other
 *     reasonDetail?: string,  — free-text, only when reason = 'other'
 *   }
 *
 * Response: { ok: true } on success, { error: string } on failure.
 *
 * Required env vars:
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 *   ALLOWED_ORIGIN            — CORS origin (optional, defaults to prod)
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "https://paradoxofacceptance.xyz";

const VALID_REASONS = new Set([
  "too_expensive",
  "not_using",
  "missing_feature",
  "switching",
  "pausing",
  "other",
]);

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

  const { walletAddress, reason, reasonDetail } = req.body as {
    walletAddress?: string;
    reason?: string;
    reasonDetail?: string;
  };

  if (!walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
    return res.status(400).json({ error: "Valid walletAddress required" });
  }

  if (!reason || !VALID_REASONS.has(reason)) {
    return res.status(400).json({ error: "Valid reason required" });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    // Non-fatal for the UI — log and respond ok so the portal redirect still happens
    console.warn("cancel-survey: missing Supabase env vars — skipping DB write");
    return res.status(200).json({ ok: true });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { error } = await supabase.from("churn_events").insert({
      wallet_address: walletAddress.toLowerCase(),
      reason,
      ...(reason === "other" && reasonDetail ? { reason_detail: reasonDetail } : {}),
      cancelled_at: new Date().toISOString(),
    });

    if (error) {
      console.error("cancel-survey: DB insert failed:", error.message);
      // Non-fatal — return ok so the portal redirect proceeds
      return res.status(200).json({ ok: true });
    }

    console.log(`cancel-survey: recorded churn event wallet=${walletAddress} reason=${reason}`);
    return res.status(200).json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("cancel-survey: unexpected error:", message);
    // Non-fatal
    return res.status(200).json({ ok: true });
  }
}
