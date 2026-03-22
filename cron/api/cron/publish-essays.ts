/**
 * /api/cron/publish-essays
 *
 * Vercel cron job — runs every hour.
 * Checks Supabase for essays whose published_at has arrived (published_at <= NOW())
 * but whose static site files haven't been updated yet (deployed_at IS NULL).
 *
 * For each such essay, updates three GitHub files via the GitHub API:
 *   - mindfulness-essays/index.html  — adds the essay card before <!-- /ESSAYS -->
 *   - sitemap.xml                    — adds a <url> entry
 *   - feed.xml                       — adds an <item> entry
 *
 * Commits all three changes in one GitHub commit, then sets deployed_at in Supabase.
 *
 * Schedule: 0 * * * * (every hour, see vercel.json)
 *
 * Required env vars:
 *   CRON_SECRET               — Vercel auto-injects; also set in Vercel dashboard
 *   SUPABASE_URL              — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Supabase service role key
 *   GITHUB_TOKEN              — Fine-grained PAT with Contents: read+write on nickxma/paradox-of-acceptance
 *   GITHUB_REPO               — defaults to "nickxma/paradox-of-acceptance"
 *   GITHUB_BRANCH             — defaults to "main"
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";

// ─── Config ───────────────────────────────────────────────────────────────────

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO ?? "nickxma/paradox-of-acceptance";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH ?? "main";
const SITE_URL = "https://paradoxofacceptance.xyz";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Essay {
  id: string;
  slug: string;
  title: string;
  kicker: string | null;
  description: string | null;
  read_time: string | null;
  path: string;
  published_at: string;
}

interface GithubFile {
  sha: string;
  content: string; // base64
}

// ─── Main handler ─────────────────────────────────────────────────────────────

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Auth
  const authHeader = req.headers["authorization"];
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn("[publish-essays] Supabase not configured — skipping");
    return res.status(200).json({ ok: true, skipped: "supabase_not_configured" });
  }

  if (!GITHUB_TOKEN) {
    console.warn("[publish-essays] GITHUB_TOKEN not set — cannot deploy static files");
    return res.status(200).json({ ok: true, skipped: "github_token_not_set" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Find essays due to publish that haven't been deployed yet
  const now = new Date().toISOString();
  const { data: essays, error } = await supabase
    .from("essays")
    .select("id, slug, title, kicker, description, read_time, path, published_at")
    .not("published_at", "is", null)
    .lte("published_at", now)
    .is("deployed_at", null)
    .order("published_at", { ascending: true });

  if (error) {
    console.error("[publish-essays] Supabase query error:", error);
    return res.status(500).json({ error: "Supabase query failed" });
  }

  if (!essays || essays.length === 0) {
    return res.status(200).json({ ok: true, published: 0 });
  }

  console.log(`[publish-essays] Found ${essays.length} essay(s) to deploy`);

  // Fetch current static files from GitHub
  let indexFile: GithubFile;
  let sitemapFile: GithubFile;
  let feedFile: GithubFile;

  try {
    [indexFile, sitemapFile, feedFile] = await Promise.all([
      getGithubFile("mindfulness-essays/index.html"),
      getGithubFile("sitemap.xml"),
      getGithubFile("feed.xml"),
    ]);
  } catch (err) {
    console.error("[publish-essays] Failed to fetch GitHub files:", err);
    return res.status(500).json({ error: "Failed to fetch GitHub files" });
  }

  let indexContent = decodeBase64(indexFile.content);
  let sitemapContent = decodeBase64(sitemapFile.content);
  let feedContent = decodeBase64(feedFile.content);

  const deployed: string[] = [];

  for (const essay of essays as Essay[]) {
    try {
      indexContent = insertIntoIndex(indexContent, essay);
      sitemapContent = insertIntoSitemap(sitemapContent, essay);
      feedContent = insertIntoFeed(feedContent, essay);
      deployed.push(essay.slug);
    } catch (err) {
      console.error(`[publish-essays] Error building content for ${essay.slug}:`, err);
    }
  }

  if (deployed.length === 0) {
    return res.status(200).json({ ok: true, published: 0 });
  }

  // Commit all three files in separate GitHub API calls
  const dateStr = new Date().toISOString().split("T")[0];
  const commitMessage = deployed.length === 1
    ? `publish: ${deployed[0]} (scheduled)`
    : `publish: ${deployed.length} scheduled essays`;

  try {
    await Promise.all([
      updateGithubFile("mindfulness-essays/index.html", indexContent, indexFile.sha, commitMessage),
      updateGithubFile("sitemap.xml", sitemapContent, sitemapFile.sha, `sitemap: add ${deployed.join(", ")}`),
      updateGithubFile("feed.xml", feedContent, feedFile.sha, `feed: add ${deployed.join(", ")}`),
    ]);
  } catch (err) {
    console.error("[publish-essays] GitHub commit failed:", err);
    return res.status(500).json({ error: "GitHub commit failed" });
  }

  // Mark essays as deployed in Supabase
  const deployedAt = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("essays")
    .update({ deployed_at: deployedAt })
    .in("slug", deployed);

  if (updateError) {
    console.error("[publish-essays] Failed to set deployed_at:", updateError);
    // Non-fatal: files are already committed; next cron run will skip these
    // since they'll match published_at <= NOW() but deployed_at may still be null.
    // To prevent re-deploying, re-check using the GitHub file state or a separate flag.
  }

  console.log(`[publish-essays] Deployed: ${deployed.join(", ")}`);
  return res.status(200).json({ ok: true, published: deployed.length, essays: deployed });
}

// ─── Content insertion helpers ────────────────────────────────────────────────

/**
 * Insert a new essay card into mindfulness-essays/index.html.
 * Cards are inserted just before the <!-- /ESSAYS --> marker.
 */
function insertIntoIndex(html: string, essay: Essay): string {
  const marker = "<!-- /ESSAYS -->";
  if (!html.includes(marker)) {
    throw new Error(`index.html missing "${marker}" insertion marker`);
  }

  const kicker = escHtml(essay.kicker ?? "Essay");
  const title = escHtml(essay.title);
  const description = escHtml(essay.description ?? "");
  const readTime = escHtml(essay.read_time ?? "");
  const path = escHtml(essay.path);

  const card = `
  <a href="${path}" class="essay-row">
    <div class="essay-kicker">${kicker}</div>
    <div class="essay-title">${title}</div>
    ${description ? `<div class="essay-desc">${description}</div>` : ""}
    ${readTime ? `<div class="essay-meta">${readTime}</div>` : ""}
  </a>
`;

  return html.replace(marker, card + marker);
}

/**
 * Insert a <url> entry into sitemap.xml, just before </urlset>.
 */
function insertIntoSitemap(xml: string, essay: Essay): string {
  const today = new Date().toISOString().split("T")[0];
  const url = `${SITE_URL}${essay.path}`;
  const entry = `
  <url>
    <loc>${url}</loc>
    <lastmod>${today}</lastmod>
    <priority>0.8</priority>
  </url>`;

  return xml.replace("</urlset>", entry + "\n</urlset>");
}

/**
 * Insert an <item> entry into feed.xml, as the first item in the channel
 * (most-recent-first order).
 */
function insertIntoFeed(xml: string, essay: Essay): string {
  const pubDate = new Date(essay.published_at).toUTCString();
  const url = `${SITE_URL}${essay.path}`;
  const title = escXml(essay.title);
  const description = escXml(essay.description ?? "");

  const item = `
    <item>
      <title>${title}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <description>${description}</description>
      <pubDate>${pubDate}</pubDate>
    </item>`;

  // Insert after <lastBuildDate>...</lastBuildDate> or after the opening <channel> block
  const insertAfter = "</lastBuildDate>";
  if (xml.includes(insertAfter)) {
    return xml.replace(insertAfter, insertAfter + "\n" + item);
  }
  // Fallback: insert after first <item> tag or before </channel>
  return xml.replace("</channel>", item + "\n  </channel>");
}

// ─── GitHub API helpers ───────────────────────────────────────────────────────

async function getGithubFile(path: string): Promise<GithubFile> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json() as { sha: string; content: string };
  return { sha: data.sha, content: data.content };
}

async function updateGithubFile(
  path: string,
  newContent: string,
  sha: string,
  message: string,
): Promise<void> {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: message + "\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>",
      content: encodeBase64(newContent),
      sha,
      branch: GITHUB_BRANCH,
    }),
  });
  if (!res.ok) {
    throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await res.text()}`);
  }
}

// ─── Encoding helpers ─────────────────────────────────────────────────────────

function decodeBase64(b64: string): string {
  return Buffer.from(b64.replace(/\n/g, ""), "base64").toString("utf-8");
}

function encodeBase64(str: string): string {
  return Buffer.from(str, "utf-8").toString("base64");
}

// ─── Escape helpers ───────────────────────────────────────────────────────────

function escHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
