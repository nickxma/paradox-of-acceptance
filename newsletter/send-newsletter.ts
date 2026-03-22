/**
 * send-newsletter.ts
 *
 * Sends a newsletter to all subscribed contacts in the Resend Audience.
 *
 * Usage:
 *   SUBJECT="Essay title" CONTENT_HTML="<p>...</p>" npm run send
 *
 * Or from the Content Lead pipeline:
 *   node -e "
 *     process.env.SUBJECT = title;
 *     process.env.CONTENT_HTML = html;
 *     import('./send-newsletter.ts');
 *   "
 *
 * The script sends via Resend Broadcasts, which handles:
 *   - Unsubscribe links (CAN-SPAM compliant)
 *   - Delivery to all subscribed audience members
 *   - Open/click tracking
 *
 * IMPORTANT: Do NOT run against the full list until Nick approves
 * the welcome sequence copy.
 */

import { Resend } from "resend";
import dotenv from "dotenv";

dotenv.config();

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;
const EMAIL_FROM = process.env.EMAIL_FROM;
const EMAIL_REPLY_TO = process.env.EMAIL_REPLY_TO;
const SUBJECT = process.env.SUBJECT;
const CONTENT_HTML = process.env.CONTENT_HTML;

if (!RESEND_API_KEY || !RESEND_AUDIENCE_ID || !EMAIL_FROM || !SUBJECT || !CONTENT_HTML) {
  console.error(
    "Missing required env vars: RESEND_API_KEY, RESEND_AUDIENCE_ID, EMAIL_FROM, SUBJECT, CONTENT_HTML"
  );
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

async function main() {
  console.log(`Creating broadcast: "${SUBJECT}"`);

  // Create broadcast
  const { data: broadcast, error: createError } = await (resend as any).broadcasts.create({
    audienceId: RESEND_AUDIENCE_ID!,
    from: EMAIL_FROM!,
    replyTo: EMAIL_REPLY_TO,
    subject: SUBJECT!,
    html: CONTENT_HTML!,
  });

  if (createError || !broadcast) {
    console.error("Failed to create broadcast:", createError);
    process.exit(1);
  }

  console.log(`Broadcast created: ${broadcast.id}`);

  // Send broadcast
  const { data: sent, error: sendError } = await (resend as any).broadcasts.send(broadcast.id);

  if (sendError) {
    console.error("Failed to send broadcast:", sendError);
    process.exit(1);
  }

  console.log(`Broadcast sent. Check Resend dashboard for delivery stats.`);
  console.log(`  Broadcast ID: ${broadcast.id}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
