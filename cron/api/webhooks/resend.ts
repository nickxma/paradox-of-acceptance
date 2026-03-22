/**
 * POST /api/webhooks/resend
 *
 * Handles Resend webhook events.
 *
 * Handled events:
 *   email.opened    — set opened_at on the matching onboarding_sequences row
 *   email.clicked   — reset has_received_reengagement_email on the subscriber (re-engagement only)
 *   email.bounced   — set subscribers.status = 'bounced' to suppress future sends
 *   email.complained — set subscribers.status = 'unsubscribed', log to complaints table
 *
 * Signature verification: Resend signs webhook payloads with svix.
 * Set RESEND_WEBHOOK_SECRET in Vercel env (from Resend dashboard → Webhooks).
 *
 * Required env vars:
 *   RESEND_WEBHOOK_SECRET     — webhook signing secret from Resend dashboard
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "crypto";

const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET ?? "";
const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

// Vercel: disable body parser to get raw bytes for HMAC verification
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

// ─── Resend svix signature verification ──────────────────────────────────────
// Resend uses the svix webhook standard.
// Headers: svix-id, svix-timestamp, svix-signature
// Signed payload: "{svix-id}.{svix-timestamp}.{raw-body}"
// Expected: "v1,{base64(hmac-sha256(secret, signed-payload))}"

function verifySvixSignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secret: string
): boolean {
  const svixId = String(headers["svix-id"] ?? "");
  const svixTimestamp = String(headers["svix-timestamp"] ?? "");
  const svixSignature = String(headers["svix-signature"] ?? "");

  if (!svixId || !svixTimestamp || !svixSignature) return false;

  // Reject timestamps older than 5 minutes to prevent replay attacks
  const ts = parseInt(svixTimestamp, 10);
  if (isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const signedPayload = `${svixId}.${svixTimestamp}.${rawBody.toString("utf8")}`;

  // Secret may be prefixed with "whsec_" — strip it
  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const hmac = createHmac("sha256", secretBytes);
  hmac.update(signedPayload);
  const expectedSig = `v1,${hmac.digest("base64")}`;

  // svix-signature may contain multiple space-separated sigs (key rotation)
  const incomingSigs = svixSignature.split(" ");
  return incomingSigs.some((sig) => {
    try {
      return timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
    } catch {
      return false;
    }
  });
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await getRawBody(req);

  // Verify signature if secret is configured
  if (RESEND_WEBHOOK_SECRET) {
    const valid = verifySvixSignature(rawBody, req.headers as Record<string, string | undefined>, RESEND_WEBHOOK_SECRET);
    if (!valid) {
      console.error("resend-webhook: invalid signature");
      return res.status(401).json({ error: "Invalid signature" });
    }
  } else {
    console.warn("resend-webhook: RESEND_WEBHOOK_SECRET not set — skipping signature verification");
  }

  let payload: ResendWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const eventType = payload.type;
  console.log(`resend-webhook: received event type=${eventType}`);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    // For non-open events that require DB, fail explicitly
    if (eventType !== "email.opened") {
      console.error("resend-webhook: Supabase not configured");
      return res.status(500).json({ error: "Supabase not configured" });
    }
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  switch (eventType) {
    case "email.opened":
      return handleOpened(payload, supabase, res);
    case "email.clicked":
      return handleClicked(payload, supabase, res);
    case "email.bounced":
      return handleBounced(payload, supabase, res);
    case "email.complained":
      return handleComplained(payload, supabase, res);
    default:
      return res.status(200).json({ ignored: true, type: eventType });
  }
}

// ─── email.opened ─────────────────────────────────────────────────────────────

async function handleOpened(
  payload: ResendWebhookPayload,
  supabase: SupabaseClient,
  res: VercelResponse
) {
  const emailId = payload.data?.email_id;
  if (!emailId) {
    console.warn("resend-webhook: email.opened missing email_id");
    return res.status(200).json({ ignored: true, reason: "no email_id" });
  }

  // Only process if this is an onboarding email (check tags)
  const tags: Array<{ name: string; value: string }> = payload.data?.tags ?? [];
  const isOnboarding = tags.some((t) => t.name === "sequence" && t.value === "onboarding");

  if (!isOnboarding) {
    return res.status(200).json({ ignored: true, reason: "not onboarding sequence" });
  }

  // Update opened_at on the matching onboarding_sequences row
  const { error: updateError, count } = await supabase
    .from("onboarding_sequences")
    .update({ opened_at: new Date().toISOString() })
    .eq("resend_email_id", emailId)
    .is("opened_at", null); // only update first open

  if (updateError) {
    console.error(`resend-webhook: failed to update opened_at for email_id=${emailId}: ${updateError.message}`);
    return res.status(500).json({ error: updateError.message });
  }

  console.log(`resend-webhook: opened_at updated for email_id=${emailId} rows=${count}`);
  return res.status(200).json({ updated: count });
}

// ─── email.clicked ────────────────────────────────────────────────────────────

/**
 * When a re-engagement email is clicked, reset has_received_reengagement_email
 * so the subscriber can receive another re-engagement email after another 7-day gap.
 * Non-re-engagement clicks (other sequences) are ignored.
 */
async function handleClicked(
  payload: ResendWebhookPayload,
  supabase: SupabaseClient,
  res: VercelResponse
) {
  // Only process clicks from re-engagement emails
  const tags: Array<{ name: string; value: string }> = payload.data?.tags ?? [];
  const isReengagement = tags.some((t) => t.name === "sequence" && t.value === "reengagement");

  if (!isReengagement) {
    return res.status(200).json({ ignored: true, reason: "not reengagement sequence" });
  }

  const recipients = payload.data?.to ?? [];
  if (recipients.length === 0) {
    console.warn("resend-webhook: email.clicked missing recipient");
    return res.status(200).json({ ignored: true, reason: "no recipient" });
  }

  const email = recipients[0].toLowerCase().trim();

  // Clear the re-engagement flag so they're eligible again after another 7-day gap
  const { error: updateError } = await supabase
    .from("subscribers")
    .update({ has_received_reengagement_email: false })
    .eq("email", email)
    .eq("has_received_reengagement_email", true); // idempotent

  if (updateError) {
    console.error(`resend-webhook: failed to reset reengagement flag for ${email}: ${updateError.message}`);
    return res.status(500).json({ error: updateError.message });
  }

  console.log(`resend-webhook: reengagement flag cleared for ${email} on click`);
  return res.status(200).json({ processed: true, email, event: "clicked", action: "reengagement_reset" });
}

// ─── email.bounced ────────────────────────────────────────────────────────────

async function handleBounced(
  payload: ResendWebhookPayload,
  supabase: SupabaseClient,
  res: VercelResponse
) {
  const recipients = payload.data?.to ?? [];
  if (recipients.length === 0) {
    console.warn("resend-webhook: email.bounced missing recipient");
    return res.status(200).json({ ignored: true, reason: "no recipient" });
  }

  const email = recipients[0].toLowerCase().trim();
  const emailId = payload.data?.email_id ?? null;

  // Set status = 'bounced' — suppresses all future sends to this address
  const { error: updateError } = await supabase
    .from("subscribers")
    .update({ status: "bounced" })
    .eq("email", email)
    .neq("status", "bounced"); // idempotent — skip if already bounced

  if (updateError) {
    console.error(`resend-webhook: failed to set bounced for ${email}: ${updateError.message}`);
    return res.status(500).json({ error: updateError.message });
  }

  // Log to email_events for audit trail
  await supabase.from("email_events").insert({
    email_id: emailId,
    type: "email.bounced",
    recipient_email: email,
    metadata: payload.data ?? null,
  });

  console.log(`resend-webhook: marked ${email} as bounced (email_id=${emailId})`);
  return res.status(200).json({ processed: true, email, event: "bounced" });
}

// ─── email.complained ─────────────────────────────────────────────────────────

async function handleComplained(
  payload: ResendWebhookPayload,
  supabase: SupabaseClient,
  res: VercelResponse
) {
  const recipients = payload.data?.to ?? [];
  if (recipients.length === 0) {
    console.warn("resend-webhook: email.complained missing recipient");
    return res.status(200).json({ ignored: true, reason: "no recipient" });
  }

  const email = recipients[0].toLowerCase().trim();
  const emailId = payload.data?.email_id ?? null;

  // Set status = 'unsubscribed' — spam complaints must suppress future sends
  const { error: updateError } = await supabase
    .from("subscribers")
    .update({ status: "unsubscribed" })
    .eq("email", email)
    .not("status", "in", '("bounced","unsubscribed")'); // idempotent

  if (updateError) {
    console.error(`resend-webhook: failed to unsubscribe ${email} on complaint: ${updateError.message}`);
    return res.status(500).json({ error: updateError.message });
  }

  // Log to complaints table for complaint_rate metric
  const { error: insertError } = await supabase.from("complaints").insert({
    email,
    complained_at: new Date().toISOString(),
    message_id: emailId,
  });

  if (insertError) {
    // Non-fatal — subscriber is already unsubscribed
    console.error(`resend-webhook: failed to insert complaint record for ${email}: ${insertError.message}`);
  }

  // Log to email_events for audit trail
  await supabase.from("email_events").insert({
    email_id: emailId,
    type: "email.complained",
    recipient_email: email,
    metadata: payload.data ?? null,
  });

  console.log(`resend-webhook: unsubscribed ${email} on spam complaint (email_id=${emailId})`);
  return res.status(200).json({ processed: true, email, event: "complained" });
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ResendWebhookPayload {
  type: string;
  data?: {
    email_id?: string;
    to?: string[];
    tags?: Array<{ name: string; value: string }>;
    [key: string]: unknown;
  };
}
