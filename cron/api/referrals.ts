/**
 * GET /api/referrals?wallet=0x...
 *
 * Returns the current user's referral program status:
 *   - Their unique referral code and shareable link
 *   - Total number of sign-ups via their code
 *   - Breakdown of pending vs. credited conversions
 *
 * A "pending" conversion means the referee signed up but has not yet completed
 * their trial and paid. A "credited" conversion means the referrer has received
 * their 1-month Stripe credit.
 *
 * Required env vars:
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 *   SITE_URL                  — Base URL for building the referral link (optional)
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const SITE_URL = process.env.SITE_URL ?? "https://paradoxofacceptance.xyz";
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

  const walletLower = wallet.toLowerCase();
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Fetch (or lazily create) referral code for this user
  let { data: codeRow, error: codeErr } = await supabase
    .from("referral_codes")
    .select("code")
    .eq("user_id", walletLower)
    .single();

  if (codeErr && codeErr.code !== "PGRST116") {
    console.error("referrals: db error fetching code:", codeErr.message);
    return res.status(500).json({ error: "Database error" });
  }

  if (!codeRow) {
    // Generate a referral code on first access
    const newCode = await generateUniqueCode(supabase);
    if (!newCode) {
      console.error("referrals: failed to generate unique code after retries");
      return res.status(500).json({ error: "Could not generate referral code" });
    }

    const { data: inserted, error: insertErr } = await supabase
      .from("referral_codes")
      .insert({ user_id: walletLower, code: newCode })
      .select("code")
      .single();

    if (insertErr) {
      // Race condition: another request may have inserted concurrently — re-fetch
      const { data: refetched } = await supabase
        .from("referral_codes")
        .select("code")
        .eq("user_id", walletLower)
        .single();
      codeRow = refetched;
    } else {
      codeRow = inserted;
    }
  }

  if (!codeRow) {
    return res.status(500).json({ error: "Could not retrieve referral code" });
  }

  const { code } = codeRow;

  // Fetch all conversions for this code
  const { data: conversions, error: convErr } = await supabase
    .from("referral_conversions")
    .select("id, referee_user_id, created_at, converted_at, credited_at")
    .eq("code", code)
    .order("created_at", { ascending: false });

  if (convErr) {
    console.error("referrals: db error fetching conversions:", convErr.message);
    return res.status(500).json({ error: "Database error" });
  }

  const allConversions = conversions ?? [];

  return res.status(200).json({
    code,
    referralLink: `${SITE_URL}/pass/?ref=${code}`,
    referralCount: allConversions.length,
    pendingConversions: allConversions.filter((c) => c.converted_at === null).length,
    creditedConversions: allConversions.filter((c) => c.credited_at !== null).length,
    conversions: allConversions.map((c) => ({
      id: c.id,
      refereeId: c.referee_user_id,
      signedUpAt: c.created_at,
      convertedAt: c.converted_at,
      creditedAt: c.credited_at,
    })),
  });
}

/**
 * Generates a unique 8-character alphanumeric referral code.
 * Retries up to 5 times to avoid collisions (statistically negligible).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function generateUniqueCode(supabase: any): Promise<string | null> {
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
    if (!data) return code; // no collision
  }
  return null;
}
