/**
 * import-list.ts
 *
 * Imports audience-list.csv into a Resend Audience.
 *
 * Usage:
 *   cp .env.example .env       # fill in RESEND_API_KEY and RESEND_AUDIENCE_ID
 *   npm install
 *   npm run import-list
 *
 * The script batches in groups of 50 (Resend API limit per call) and
 * prints a running tally. It skips malformed rows. Safe to re-run —
 * Resend deduplicates by email address within an audience.
 */

import { createReadStream } from "fs";
import { createInterface } from "readline";
import { Resend } from "resend";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;
const AUDIENCE_CSV_PATH = process.env.AUDIENCE_CSV_PATH;

if (!RESEND_API_KEY || !RESEND_AUDIENCE_ID || !AUDIENCE_CSV_PATH) {
  console.error(
    "Missing required env vars: RESEND_API_KEY, RESEND_AUDIENCE_ID, AUDIENCE_CSV_PATH"
  );
  process.exit(1);
}

const resend = new Resend(RESEND_API_KEY);

// Resolve CSV path relative to this script
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const csvPath = path.resolve(__dirname, AUDIENCE_CSV_PATH);

type Contact = {
  email: string;
  firstName?: string;
  unsubscribed: boolean;
};

async function readContacts(filePath: string): Promise<Contact[]> {
  const contacts: Contact[] = [];
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) {
      isHeader = false;
      continue;
    }
    const [firstName, email] = line.split(",").map((s) => s.trim());
    if (!email || !email.includes("@")) continue;
    contacts.push({ email, firstName: firstName || undefined, unsubscribed: false });
  }
  return contacts;
}

async function batchImport(contacts: Contact[]) {
  const BATCH_SIZE = 50;
  let imported = 0;
  let errors = 0;

  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    const batch = contacts.slice(i, i + BATCH_SIZE);

    // Resend doesn't have a bulk-create contacts endpoint yet,
    // so we create them one at a time (still fast with Promise.allSettled)
    const results = await Promise.allSettled(
      batch.map((c) =>
        resend.contacts.create({
          audienceId: RESEND_AUDIENCE_ID!,
          email: c.email,
          firstName: c.firstName,
          unsubscribed: c.unsubscribed,
        })
      )
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        imported++;
      } else {
        errors++;
        // Only log first 10 errors to avoid noise
        if (errors <= 10) {
          console.error(`  Error: ${result.reason?.message ?? result.reason}`);
        }
      }
    }

    const pct = (((i + BATCH_SIZE) / contacts.length) * 100).toFixed(1);
    process.stdout.write(
      `\r  Progress: ${Math.min(i + BATCH_SIZE, contacts.length)}/${contacts.length} (${pct}%) — imported: ${imported}, errors: ${errors}`
    );

    // Small pause to respect rate limits
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(); // newline after progress
  return { imported, errors };
}

async function main() {
  console.log(`Loading contacts from: ${csvPath}`);
  const contacts = await readContacts(csvPath);
  console.log(`Found ${contacts.length} valid contacts`);

  console.log(`Importing to Resend Audience: ${RESEND_AUDIENCE_ID}`);
  const { imported, errors } = await batchImport(contacts);

  console.log(`\nDone.`);
  console.log(`  Imported: ${imported}`);
  console.log(`  Errors:   ${errors}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
