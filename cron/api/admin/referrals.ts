/**
 * GET /api/admin/referrals
 *
 * Returns top referrers dashboard data.
 *
 * Auth: X-Admin-Secret header must match ADMIN_SECRET env var.
 *
 * Response:
 *   {
 *     topReferrers: [
 *       {
 *         userId: string,         // wallet_address
 *         code: string,
 *         totalReferrals: number,
 *         pendingReferrals: number,   // signed up, trial not yet completed
 *         convertedReferrals: number, // trial completed and paid
 *         creditedReferrals: number,  // referrer has received Stripe credit
 *       }
 *     ],
 *     totals: { referralCodes, totalConversions, pending, converted, credited }
 *   }
 *
 * Required env vars:
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 *   ADMIN_SECRET              — shared secret for admin endpoints
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "https://paradoxofacceptance.xyz";

function auth(req: VercelRequest): boolean {
  return !!ADMIN_SECRET && req.headers["x-admin-secret"] === ADMIN_SECRET;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Secret");

  if (req.method === "OPTIONS") return res.status(200).end();

  if (!auth(req)) return res.status(401).json({ error: "Unauthorized" });

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "Supabase not configured" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Fetch all referral codes
  const { data: codes, error: codesErr } = await supabase
    .from("referral_codes")
    .select("user_id, code, created_at")
    .order("created_at", { ascending: false });

  if (codesErr) {
    console.error("admin/referrals: error fetching codes:", codesErr.message);
    return res.status(500).json({ error: "Database error" });
  }

  if (!codes || codes.length === 0) {
    return res.status(200).json({
      topReferrers: [],
      totals: { referralCodes: 0, totalConversions: 0, pending: 0, converted: 0, credited: 0 },
    });
  }

  // Fetch all conversions
  const { data: conversions, error: convErr } = await supabase
    .from("referral_conversions")
    .select("code, referee_user_id, converted_at, credited_at, created_at");

  if (convErr) {
    console.error("admin/referrals: error fetching conversions:", convErr.message);
    return res.status(500).json({ error: "Database error" });
  }

  const allConversions = conversions ?? [];

  // Group conversions by code
  const conversionsByCode: Record<
    string,
    Array<{ referee_user_id: string; converted_at: string | null; credited_at: string | null; created_at: string }>
  > = {};
  for (const c of allConversions) {
    if (!conversionsByCode[c.code]) conversionsByCode[c.code] = [];
    conversionsByCode[c.code]!.push(c);
  }

  // Build per-referrer stats
  const referrers = codes.map((row) => {
    const refs = conversionsByCode[row.code] ?? [];
    return {
      userId: row.user_id,
      code: row.code,
      totalReferrals: refs.length,
      pendingReferrals: refs.filter((r) => r.converted_at === null).length,
      convertedReferrals: refs.filter((r) => r.converted_at !== null).length,
      creditedReferrals: refs.filter((r) => r.credited_at !== null).length,
    };
  });

  // Sort by total referrals descending, then credited
  referrers.sort((a, b) => b.totalReferrals - a.totalReferrals || b.creditedReferrals - a.creditedReferrals);

  // Only return top 100
  const topReferrers = referrers.slice(0, 100);

  const totals = {
    referralCodes: codes.length,
    totalConversions: allConversions.length,
    pending: allConversions.filter((c) => c.converted_at === null).length,
    converted: allConversions.filter((c) => c.converted_at !== null).length,
    credited: allConversions.filter((c) => c.credited_at !== null).length,
  };

  return res.status(200).json({ topReferrers, totals });
}
