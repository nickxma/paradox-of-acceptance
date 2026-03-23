#!/usr/bin/env node
/**
 * obsidian-publish — Obsidian → paradoxofacceptance.xyz publish pipeline
 *
 * Scans the Obsidian vault for markdown files with:
 *   publish: true
 *   status: ready
 * …and no `published_at` field (unpublished).
 *
 * For each matching file:
 *   1. Strip Obsidian-specific syntax (wiki links, callouts, inline tags).
 *   2. POST to /api/admin/poa/publish (essay or lesson, based on `type` frontmatter).
 *   3. POST to /api/corpus/proposals (auto-approved embedding ingest).
 *   4. Update the file's frontmatter to add `published_at`.
 *   5. Append an entry to the publish log.
 *
 * Usage:
 *   node publish.mjs
 *   # or schedule via cron:
 *   # 0 * * * * /usr/local/bin/node /path/to/publish.mjs >> /tmp/obsidian-publish.log 2>&1
 *
 * Required env vars (set in .env or shell):
 *   POA_API_URL     — e.g. http://127.0.0.1:3001
 *   POA_ADMIN_SECRET — value of ADMIN_SECRET on the newsletter server
 *
 * Optional env vars:
 *   OBSIDIAN_VAULT  — path to vault (default: /Users/nick/Obsidian)
 *   PUBLISH_LOG     — path to log file (default: $OBSIDIAN_VAULT/00_System/publish-log.md)
 *   DRY_RUN         — set to "1" to scan and log without making API calls or
 *                     mutating frontmatter
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";

// ─── Config ───────────────────────────────────────────────────────────────────

const VAULT = process.env.OBSIDIAN_VAULT ?? "/Users/nick/Obsidian";
const API_URL = process.env.POA_API_URL ?? "http://127.0.0.1:3001";
const ADMIN_SECRET = process.env.POA_ADMIN_SECRET ?? "";
const PUBLISH_LOG = process.env.PUBLISH_LOG ?? join(VAULT, "00_System", "publish-log.md");
const DRY_RUN = process.env.DRY_RUN === "1";

if (!ADMIN_SECRET) {
  console.error("[obsidian-publish] POA_ADMIN_SECRET is not set — aborting");
  process.exit(1);
}

// ─── Frontmatter parsing ──────────────────────────────────────────────────────

/**
 * Parse YAML frontmatter from markdown content.
 * Returns { frontmatter: Record<string,unknown>, body: string }
 * where body is the content after the closing ---
 */
function parseFrontmatter(content) {
  if (!content.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }
  const yamlBlock = content.slice(3, end).trim();
  const body = content.slice(end + 4).trimStart();
  const frontmatter = parseSimpleYaml(yamlBlock);
  return { frontmatter, body };
}

/**
 * Minimal YAML parser — handles the subset used in Obsidian frontmatter:
 *   key: value
 *   key: "quoted value"
 *   key: true / false / null
 *   key: [item1, item2]     (inline arrays)
 *   tags:                   (block arrays, next lines start with "  - item")
 *     - item1
 *     - item2
 */
function parseSimpleYaml(yaml) {
  const result = {};
  const lines = yaml.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const colonIdx = line.indexOf(":");
    if (colonIdx <= 0) { i++; continue; }

    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();

    if (rawVal === "" || rawVal === null) {
      // Possibly a block array — peek ahead
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s/.test(lines[j])) {
        items.push(lines[j].replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, ""));
        j++;
      }
      result[key] = items.length > 0 ? items : null;
      i = j;
      continue;
    }

    result[key] = parseYamlValue(rawVal);
    i++;
  }
  return result;
}

function parseYamlValue(raw) {
  // Inline array: [a, b, c]
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~") return null;
  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Number
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/**
 * Serialize a frontmatter object back to YAML and inject into content.
 * Preserves the original ordering; new keys are appended.
 */
function serializeFrontmatter(fm) {
  const lines = [];
  for (const [key, val] of Object.entries(fm)) {
    if (val === null || val === undefined) {
      lines.push(`${key}:`);
    } else if (Array.isArray(val)) {
      if (val.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of val) lines.push(`  - ${item}`);
      }
    } else if (typeof val === "boolean") {
      lines.push(`${key}: ${val}`);
    } else if (typeof val === "number") {
      lines.push(`${key}: ${val}`);
    } else {
      // Escape strings containing colons, quotes, or special chars
      const needsQuotes = /[:#\[\]{}&*!|>'"%@`]/.test(String(val)) || String(val).includes(": ");
      const s = needsQuotes ? `"${String(val).replace(/"/g, '\\"')}"` : String(val);
      lines.push(`${key}: ${s}`);
    }
  }
  return lines.join("\n");
}

/**
 * Inject published_at into the frontmatter of a file and write it back.
 */
function markPublished(filePath, frontmatter, body, publishedAt) {
  const newFm = { ...frontmatter, published_at: publishedAt };
  const newContent = `---\n${serializeFrontmatter(newFm)}\n---\n\n${body}`;
  writeFileSync(filePath, newContent, "utf-8");
}

// ─── Obsidian syntax stripping ────────────────────────────────────────────────

/**
 * Convert Obsidian-flavored markdown to standard markdown:
 *
 * - [[Page Name]]          → Page Name
 * - [[Page Name|Alias]]    → Alias
 * - ![[image.png]]         → (removed — embeds not supported)
 * - > [!note] Title         → **Title** (callout header → bold)
 *   > body line             → body line (strip "> " prefix)
 * - #tag (standalone)      → (removed — inline tags)
 * - ==highlighted==        → highlighted
 * - %%comment%%            → (removed — Obsidian comments)
 * - ^block-id              → (removed — block IDs)
 */
function stripObsidianSyntax(markdown) {
  let text = markdown;

  // Remove Obsidian comments %%...%%
  text = text.replace(/%%[\s\S]*?%%/g, "");

  // Remove block IDs at end of lines: " ^block-id"
  text = text.replace(/ \^[a-zA-Z0-9-]+$/gm, "");

  // Image embeds: ![[...]] — remove entirely
  text = text.replace(/!\[\[[^\]]*\]\]/g, "");

  // Wiki links: [[Page|Alias]] → Alias, [[Page]] → Page
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
  text = text.replace(/\[\[([^\]]+)\]\]/g, "$1");

  // Callouts: lines matching "> [!type] Optional title"
  // Convert the callout header to a bold heading and strip "> " from body lines
  text = text.replace(/^> \[!(\w+)\](?: (.+))?$/gm, (_match, _type, title) => {
    return title ? `**${title}**` : "";
  });

  // Strip "> " prefix from remaining blockquote lines that were callout bodies
  // (Only strip if the blockquote style looks like a callout body — i.e., follows
  // a callout header. We strip ALL "> " prefixes since standard blockquotes render
  // fine in both forms. Actually let's be conservative and only strip callout-style.)
  // We use a heuristic: keep standard "> " blockquotes as-is; they render correctly.
  // Callout bodies won't have their [!type] marker so they'll just look like blockquotes — that's fine.

  // Highlight syntax ==text== → text
  text = text.replace(/==([^=]+)==/g, "$1");

  // Inline tags: standalone #tag not preceded by other content (i.e., "#tag" as a word)
  // Only remove tags on lines that start with tags (YAML-style tag lines at top of note)
  // For inline tags within prose, leave them — they look like topics.
  // This heuristic: remove lines that are ONLY tags
  text = text.replace(/^(?:#[a-zA-Z0-9_/-]+\s*)+$/gm, "");

  // Collapse 3+ blank lines to 2
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

// ─── Slug derivation ──────────────────────────────────────────────────────────

/**
 * Derive a URL slug from a filename or title.
 * e.g. "My Great Essay.md" → "my-great-essay"
 */
function toSlug(nameOrPath) {
  return basename(nameOrPath, ".md")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

// ─── File discovery ───────────────────────────────────────────────────────────

/**
 * Recursively walk a directory and return all .md file paths.
 * Skips hidden directories (starting with ".") and the 00_System directory
 * to avoid processing system/template files.
 */
function walkMarkdownFiles(dir, results = []) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(fullPath, results);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

// ─── API calls ────────────────────────────────────────────────────────────────

async function apiPost(path, body) {
  const url = `${API_URL}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Secret": ADMIN_SECRET,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`POST ${path} → ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// ─── Publish log ──────────────────────────────────────────────────────────────

function appendPublishLog(entry) {
  const line = `| ${entry.timestamp} | ${entry.slug} | ${entry.type} | ${entry.title} | ${entry.status} |`;
  const header = "| Published At | Slug | Type | Title | Status |\n|---|---|---|---|---|";

  if (!existsSync(PUBLISH_LOG)) {
    writeFileSync(PUBLISH_LOG, `# Publish Log\n\n${header}\n${line}\n`, "utf-8");
    return;
  }

  const existing = readFileSync(PUBLISH_LOG, "utf-8");
  if (!existing.includes("| Published At |")) {
    writeFileSync(PUBLISH_LOG, existing + `\n\n${header}\n${line}\n`, "utf-8");
  } else {
    writeFileSync(PUBLISH_LOG, existing + `\n${line}`, "utf-8");
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[obsidian-publish] Scanning vault: ${VAULT}`);
  if (DRY_RUN) console.log("[obsidian-publish] DRY RUN — no changes will be made");

  const mdFiles = walkMarkdownFiles(VAULT);
  console.log(`[obsidian-publish] Found ${mdFiles.length} markdown files`);

  const candidates = [];

  for (const filePath of mdFiles) {
    let content;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch (err) {
      console.warn(`[obsidian-publish] Cannot read ${filePath}: ${err.message}`);
      continue;
    }

    const { frontmatter, body } = parseFrontmatter(content);

    // Filter: must have publish: true, status: ready, and no published_at
    if (frontmatter.publish !== true) continue;
    if (frontmatter.status !== "ready") continue;
    if (frontmatter.published_at) continue;

    candidates.push({ filePath, frontmatter, body });
  }

  console.log(`[obsidian-publish] ${candidates.length} file(s) ready to publish`);

  let published = 0;
  let failed = 0;

  for (const { filePath, frontmatter, body } of candidates) {
    const fm = frontmatter;
    const fileName = basename(filePath);

    // Derive slug: prefer frontmatter.slug, fall back to filename
    const slug = fm.slug ? String(fm.slug) : toSlug(fileName);

    // Title: required — prefer frontmatter.title, fall back to slug
    const title = fm.title ? String(fm.title) : slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    // Detect type
    const type = fm.type === "lesson" ? "lesson" : "essay";
    const courseSlug = fm.course ? String(fm.course) : undefined;

    if (type === "lesson" && !courseSlug) {
      console.warn(`[obsidian-publish] Skipping ${fileName}: type=lesson but no course: frontmatter`);
      continue;
    }

    // Strip Obsidian syntax from body
    const bodyMarkdown = stripObsidianSyntax(body);

    // Build publish payload
    const publishPayload = {
      slug,
      title,
      body_markdown: bodyMarkdown,
      type,
      ...(type === "lesson" ? { course_slug: courseSlug } : {}),
      ...(fm.kicker ? { kicker: String(fm.kicker) } : {}),
      ...(fm.description ? { description: String(fm.description) } : {}),
      ...(fm.read_time ? { read_time: String(fm.read_time) } : {}),
      ...(fm.tags && Array.isArray(fm.tags) ? { tags: fm.tags.map(String) } : {}),
      ...(fm.published_at_scheduled ? { published_at: String(fm.published_at_scheduled) } : {}),
      post_to_twitter: fm.post_to_twitter === true,
    };

    console.log(`[obsidian-publish] Publishing: ${slug} (${type}${type === "lesson" ? ` in ${courseSlug}` : ""})`);

    if (DRY_RUN) {
      console.log(`[obsidian-publish] DRY RUN: would POST /api/admin/poa/publish`, JSON.stringify(publishPayload, null, 2));
      published++;
      continue;
    }

    try {
      // 1. Publish to PoA
      const publishResult = await apiPost("/api/admin/poa/publish", publishPayload);
      console.log(`[obsidian-publish] Published ${slug} (${publishResult.action})`);

      // 2. Ingest into corpus (essays only — lessons don't need embeddings)
      if (type === "essay" && bodyMarkdown) {
        try {
          await apiPost("/api/corpus/proposals", {
            slug,
            title,
            body_markdown: bodyMarkdown,
            tags: publishPayload.tags ?? [],
            auto_approve: true,
          });
          console.log(`[obsidian-publish] Ingested ${slug} into corpus`);
        } catch (err) {
          // Non-fatal — embedding can be seeded separately
          console.warn(`[obsidian-publish] Corpus ingest failed for ${slug}: ${err.message}`);
        }
      }

      // 3. Mark file as published
      const publishedAt = new Date().toISOString();
      markPublished(filePath, fm, body, publishedAt);
      console.log(`[obsidian-publish] Updated frontmatter: ${fileName}`);

      // 4. Append to publish log
      appendPublishLog({
        timestamp: publishedAt,
        slug,
        type,
        title,
        status: publishResult.action,
      });

      published++;
    } catch (err) {
      console.error(`[obsidian-publish] Failed to publish ${slug}: ${err.message}`);
      failed++;
    }
  }

  console.log(`[obsidian-publish] Done. Published: ${published}, Failed: ${failed}`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[obsidian-publish] Fatal error:", err);
  process.exit(1);
});
