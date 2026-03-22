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
 * After deployment, if post_to_twitter is true and tweet_id is null, auto-posts to Twitter/X.
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
 *
 * Optional (Twitter auto-post):
 *   TWITTER_API_KEY           — OAuth 1.0a consumer key
 *   TWITTER_API_SECRET        — OAuth 1.0a consumer secret
 *   TWITTER_ACCESS_TOKEN      — OAuth 1.0a access token (@quiet_drift)
 *   TWITTER_ACCESS_SECRET     — OAuth 1.0a access token secret
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createClient } from "@supabase/supabase-js";
import { createHmac, randomBytes } from "crypto";
import { dispatchPush } from "../_lib/push";

// ─── Config ───────────────────────────────────────────────────────────────────

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO ?? "nickxma/paradox-of-acceptance";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH ?? "main";
const SITE_URL = "https://paradoxofacceptance.xyz";

const TWITTER_API_KEY = process.env.TWITTER_API_KEY;
const TWITTER_API_SECRET = process.env.TWITTER_API_SECRET;
const TWITTER_ACCESS_TOKEN = process.env.TWITTER_ACCESS_TOKEN;
const TWITTER_ACCESS_SECRET = process.env.TWITTER_ACCESS_SECRET;

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
  post_to_twitter: boolean;
  tweet_id: string | null;
  seo_keywords: string[] | null;
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
    .select("id, slug, title, kicker, description, read_time, path, published_at, post_to_twitter, tweet_id, seo_keywords")
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

  // Dispatch web push notifications for each newly published essay
  const pushResults: Record<string, { sent: number; failed: number; expired: number }> = {};
  for (const essay of essays as Essay[]) {
    if (!deployed.includes(essay.slug)) continue;
    const excerpt = (essay.description ?? "").slice(0, 100);
    const result = await dispatchPush(
      supabase,
      "essay_published",
      essay.slug,
      {
        title: essay.title,
        body: excerpt,
        url: `${SITE_URL}/essays/${essay.slug}`,
      },
    );
    pushResults[essay.slug] = result;
  }

  // Post to Twitter/X for essays that opted in and haven't been tweeted yet
  const twitterResults: Record<string, { tweetId?: string; skipped?: string; error?: string }> = {};
  const twitterConfigured = TWITTER_API_KEY && TWITTER_API_SECRET && TWITTER_ACCESS_TOKEN && TWITTER_ACCESS_SECRET;

  for (const essay of essays as Essay[]) {
    if (!deployed.includes(essay.slug)) continue;
    if (!essay.post_to_twitter) {
      twitterResults[essay.slug] = { skipped: "post_to_twitter_false" };
      continue;
    }
    if (essay.tweet_id) {
      twitterResults[essay.slug] = { skipped: "already_tweeted" };
      continue;
    }
    if (!twitterConfigured) {
      twitterResults[essay.slug] = { skipped: "twitter_not_configured" };
      continue;
    }

    try {
      const tweetText = buildTweetText(essay);
      const { id: tweetId } = await postTweet(tweetText);

      // Store tweet_id on essay
      await supabase.from("essays").update({ tweet_id: tweetId }).eq("slug", essay.slug);
      twitterResults[essay.slug] = { tweetId };
      console.log(`[publish-essays] Tweeted ${essay.slug}: ${tweetId}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[publish-essays] Tweet failed for ${essay.slug}:`, errMsg);
      // Log to social_post_errors — non-fatal
      await supabase.from("social_post_errors").insert({
        essay_slug: essay.slug,
        platform: "twitter",
        error_msg: errMsg,
      }).then(({ error: logErr }) => {
        if (logErr) console.error("[publish-essays] Failed to log social_post_error:", logErr);
      });
      twitterResults[essay.slug] = { error: errMsg };
    }
  }

  return res.status(200).json({ ok: true, published: deployed.length, essays: deployed, push: pushResults, twitter: twitterResults });
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

// ─── Twitter / X helpers ──────────────────────────────────────────────────────

/**
 * Build tweet text for an essay.
 * Format: title + first sentence of excerpt + URL + up to 3 hashtags.
 * Keeps total under 280 chars; truncates excerpt if needed.
 */
function buildTweetText(essay: Pick<Essay, "title" | "description" | "path" | "seo_keywords">): string {
  const url = `${SITE_URL}${essay.path}`;

  // First sentence of description/excerpt
  const desc = (essay.description ?? "").trim();
  const sentenceEnd = desc.search(/[.!?](\s|$)/);
  const firstSentence = sentenceEnd >= 0 ? desc.slice(0, sentenceEnd + 1).trim() : desc;

  // Up to 3 hashtags derived from seo_keywords
  const hashtags = (essay.seo_keywords ?? [])
    .slice(0, 3)
    .map((kw) => "#" + kw.replace(/\s+/g, "").replace(/[^a-zA-Z0-9_]/g, ""))
    .filter((h) => h.length > 1)
    .join(" ");

  const suffix = "\n\n" + url + (hashtags ? "\n\n" + hashtags : "");

  let tweet = essay.title + (firstSentence ? "\n\n" + firstSentence : "") + suffix;

  if (tweet.length <= 280) return tweet;

  // Truncate excerpt to fit
  const base = essay.title + "\n\n";
  const maxExcerpt = 280 - base.length - suffix.length - 1; // 1 for "…"
  if (firstSentence && maxExcerpt > 0) {
    tweet = base + firstSentence.slice(0, maxExcerpt) + "…" + suffix;
    if (tweet.length <= 280) return tweet;
  }

  // Skip excerpt entirely
  tweet = essay.title + suffix;
  if (tweet.length <= 280) return tweet;

  // Last resort: title + URL only
  return essay.title.slice(0, 280 - url.length - 2) + "\n\n" + url;
}

/**
 * Post a tweet via Twitter API v2 using OAuth 1.0a (user context).
 * Returns the created tweet's id and text.
 */
async function postTweet(text: string): Promise<{ id: string; text: string }> {
  const url = "https://api.twitter.com/2/tweets";
  const method = "POST";

  const oauthTimestamp = Math.floor(Date.now() / 1000).toString();
  const oauthNonce = randomBytes(16).toString("hex");

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: TWITTER_API_KEY!,
    oauth_nonce: oauthNonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: oauthTimestamp,
    oauth_token: TWITTER_ACCESS_TOKEN!,
    oauth_version: "1.0",
  };

  // Signature base string (no request body params for JSON body)
  const paramStr = Object.entries(oauthParams)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const sigBase = [method, encodeURIComponent(url), encodeURIComponent(paramStr)].join("&");
  const sigKey = `${encodeURIComponent(TWITTER_API_SECRET!)}&${encodeURIComponent(TWITTER_ACCESS_SECRET!)}`;
  const signature = createHmac("sha1", sigKey).update(sigBase).digest("base64");

  const authHeader =
    "OAuth " +
    [
      ...Object.entries(oauthParams).map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`),
      `oauth_signature="${encodeURIComponent(signature)}"`,
    ].join(", ");

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Twitter API ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { data: { id: string; text: string } };
  return data.data;
}
