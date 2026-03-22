# Paradox of Acceptance — Operations Runbook

> Single reference for operating, deploying, and onboarding on paradoxofacceptance.xyz.
> Last updated: 2026-03-22

---

## 1. Required Environment Variables

### Newsletter server (`newsletter/.env`)

Copy `newsletter/.env.example` to `newsletter/.env`.

| Variable | Where to get it | Required? | Fails without it |
|---|---|---|---|
| `RESEND_API_KEY` | resend.com → API Keys | Yes | All email sends fail |
| `RESEND_AUDIENCE_ID` | Resend dashboard → Audiences | Yes | Sends and subscriber management fail |
| `EMAIL_FROM` | Must be a verified Resend domain address (e.g. `newsletter@paradoxofacceptance.xyz`) | Yes | Sends fail |
| `SEND_API_KEY` | `openssl rand -hex 32` | Yes | `/send` endpoint returns 401 |
| `UNSUBSCRIBE_SECRET` | `openssl rand -hex 32` | Yes | Unsubscribe link generation fails |
| `ADMIN_SECRET` | `openssl rand -hex 32` | Recommended | `/api/newsletter/send` endpoint disabled |
| `TEST_EMAIL` | Your email address | Recommended | Test sends have no destination |
| `EMAIL_REPLY_TO` | e.g. `nick@paradoxofacceptance.xyz` | Optional | Reply-to header omitted from emails |
| `ALLOW_FULL_LIST_SEND` | `"true"` — Nick must explicitly approve before setting | Optional | Full-list sends blocked (default: `false`) |
| `SUPABASE_URL` | Supabase → Project → Settings → API | Optional | Send log not persisted |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API → service_role | Optional | Send log not persisted |
| `UNSUBSCRIBE_SECRET` | `openssl rand -hex 32` | Yes | HMAC token validation fails for unsubscribes |
| `PREFERENCES_JWT_SECRET` | `openssl rand -hex 32` | Recommended | `/api/email/preferences` endpoints return 503; manage-preferences links in emails will degrade gracefully |
| `SERVER_URL` | e.g. `https://paradoxofacceptance.xyz` | Optional | Defaults to production URL; affects unsubscribe and preferences link generation |
| `PORT` | e.g. `3200` | Optional | Defaults to `3200` |
| `PREVIEW_SECRET` | `openssl rand -hex 32` | Recommended | `/api/admin/essays/:slug/preview-token` returns 503; preview links cannot be generated |

### Acceptance Pass frontend (`pass-src/.env`)

| Variable | Value | Notes |
|---|---|---|
| `VITE_PRIVY_APP_ID` | `cmmyfvex101cy0clawnzxpur2` | Privy dashboard: dashboard.privy.io |
| `VITE_CONTRACT_ADDRESS` | `0x9691107411AFB05b81CfDE537Efc4a00b9b1bB69` | ERC-1155 on Base mainnet |
| `VITE_CHAIN_ENV` | `production` | Set to `testnet` for Base Sepolia testing |

### Acceptance Pass contract (`contracts/.env`)

| Variable | Notes |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | Private key for the deployer wallet — never commit |
| `OWNER_ADDRESS` | `0x60dFFC7aB012e988A8aC8048bA29f16C6CF067b7` |
| `TOKEN_URI` | `https://paradoxofacceptance.xyz/pass/metadata/{id}.json` |
| `BASE_SEPOLIA_RPC_URL` | `https://sepolia.base.org` |
| `BASE_RPC_URL` | `https://mainnet.base.org` |

---

## 2. Deploy Process

The site is a static GitHub Pages site. There is no build step for the main site — HTML files are served directly from the `main` branch.

### Normal deploy (essays, admin pages, etc.)

```bash
git add .
git commit -m "your message"
git push origin main
```

GitHub Pages auto-serves the updated files within ~1 minute.

**Live URL:** https://paradoxofacceptance.xyz

### Deploy the Acceptance Pass frontend

The Pass frontend is a Vite/React app. Built output is committed to `pass/`.

```bash
cd pass-src
npm install
npm run build
# Output goes to ../pass/ — commit it
cd ..
git add pass/
git commit -m "build: update pass frontend"
git push origin main
```

**Pass URL:** https://paradoxofacceptance.xyz/pass/

### Deploy the newsletter server

The newsletter server is a local Node.js process — it is not hosted on any platform automatically. Run it manually when needed:

```bash
cd newsletter
npm install
cp .env.example .env   # fill in all vars if first time
npm run server
# Listens on http://127.0.0.1:3200
```

For production/persistent hosting, run it as a background process or set up a simple systemd/launchd service. No deployment automation currently exists (GitHub auth pending).

### Enable /newsletter/{slug} clean URLs

The newsletter server (`server.ts`) now handles `GET /newsletter/:slug` and returns a server-side-rendered HTML page. For these URLs to work in production, the reverse proxy (nginx/Caddy) must route slug paths to the Node.js server **before** falling through to static files.

**Nginx example** (add to the server block, before the GitHub Pages static location):

```nginx
# Newsletter issue browser previews — route to Node.js server
# Must come before the static catch-all so slugs are handled by the app
location ~ ^/newsletter/([a-z0-9][a-z0-9-]*[a-z0-9])/?$ {
    proxy_pass http://127.0.0.1:3200;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

**Caddy example:**

```caddyfile
@newsletter_slug path_regexp ^/newsletter/([a-z0-9][a-z0-9-]+[a-z0-9])/?$
reverse_proxy @newsletter_slug http://127.0.0.1:3200
```

Static paths (`/newsletter/` and `/newsletter/issue/`) continue to be served from GitHub Pages — the regex above only matches `/newsletter/{slug}` patterns, not those exact paths.

### Enable /essays/preview/{token} preview links

Essay draft preview pages are server-rendered by `server.ts`. Add these proxy rules alongside the newsletter slug rule:

**Nginx example:**

```nginx
# Essay draft previews — route all /essays/preview/ requests to Node.js server
location ~ ^/essays/preview/ {
    proxy_pass http://127.0.0.1:3200;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

**Caddy example:**

```caddyfile
@essay_preview path /essays/preview/*
reverse_proxy @essay_preview http://127.0.0.1:3200
```

The public feedback API (`POST /api/essays/preview/:token/feedback`) is also served by the Node.js server — it will work automatically since `/api/` is already proxied.

**Setup steps:**
1. Run `newsletter/essay-preview-schema.sql` in Supabase SQL Editor.
2. Add `PREVIEW_SECRET` to `newsletter/.env` (`openssl rand -hex 32`).
3. Add the nginx/Caddy rule above and reload the proxy.
4. In the essay editor (`/admin/essays/edit/?slug=…`), use the **Preview Link** panel to generate, copy, or revoke links.

---

## 3. Send a Newsletter

> **Important:** Full-list sends require Nick's explicit approval. Do not set `ALLOW_FULL_LIST_SEND=true` without approval.

### 1. Start the newsletter server (if not already running)

```bash
cd newsletter
npm run server
```

### 2. Test send (safe — goes to one address only)

```bash
curl -X POST http://127.0.0.1:3200/api/newsletter/send \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -d '{
    "subject": "Essay title",
    "htmlBody": "<p>Your essay HTML here...</p>",
    "textBody": "Your plain text here.",
    "testMode": true
  }'
```

Response: `{ "status": "sent", "mode": "test", "to": "<TEST_EMAIL>", ... }`

### 3. Full-list send (requires Nick approval)

1. Nick approves explicitly.
2. Set `ALLOW_FULL_LIST_SEND=true` in `newsletter/.env`.
3. Restart the server.
4. Send:

```bash
curl -X POST http://127.0.0.1:3200/api/newsletter/send \
  -H "Content-Type: application/json" \
  -H "X-Admin-Secret: $ADMIN_SECRET" \
  -d '{
    "subject": "Essay title",
    "htmlBody": "<p>Your essay HTML here...</p><p><a href=\"{{unsubscribe}}\">Unsubscribe</a></p>",
    "testMode": false
  }'
```

Use `{{unsubscribe}}` and `{{manage_preferences}}` in `htmlBody` — both are replaced per-recipient automatically. `{{manage_preferences}}` becomes a 30-day signed JWT preferences link.

Add a `sendType` field to control preference-based filtering (default: `"newsletter"`):

```json
{
  "subject": "...",
  "htmlBody": "...",
  "testMode": false,
  "sendType": "newsletter"
}
```

Valid `sendType` values: `"newsletter"`, `"weekly_digest"`, `"course_updates"`. Subscribers who have opted out of that category are automatically excluded.

For ~26K recipients, expect 2–3 minutes. Check Resend dashboard for delivery stats after.

### 4b. Run newsletter slug migration

Run `newsletter/slug_migration.sql` in the Supabase SQL Editor to add the `slug` column. This enables clean `/newsletter/{slug}/` permalink URLs. Safe to run on an existing database — uses `IF NOT EXISTS`.

### 5. Subscriber preference center

The preference center lives at `https://paradoxofacceptance.xyz/email/preferences/?token={jwt}`.

**One-time setup (run in Supabase SQL Editor):**

```sql
-- Run newsletter/subscriber_preferences.sql
```

Subscribers arrive there via the `{{manage_preferences}}` link in email footers. The JWT token is HS256-signed using `PREFERENCES_JWT_SECRET` with a 30-day TTL.

**Resend a preferences link manually:**

```bash
curl -X POST http://127.0.0.1:3200/api/email/preferences/send-link \
  -H "Content-Type: application/json" \
  -d '{"email": "subscriber@example.com"}'
```

### 4. Check broadcast status

```bash
curl http://127.0.0.1:3200/status/<broadcastId> \
  -H "X-Api-Key: $SEND_API_KEY"
```

### Admin UI (browser)

Navigate to: https://paradoxofacceptance.xyz/admin/newsletter/

Auth: enter `ADMIN_SECRET` in the password prompt.

---

## 4. Adding a New Essay

Essays are plain HTML files served by GitHub Pages. There is no markdown-to-HTML pipeline — write HTML directly.

### Steps

1. **Create the folder and file:**

   ```
   mindfulness-essays/<essay-slug>/index.html
   ```

   Use an existing essay as a template (e.g. copy `mindfulness-essays/the-avoidance-problem/index.html`).

2. **Required `<head>` fields** — update these for every new essay:

   ```html
   <title>Essay Title — Paradox of Acceptance</title>
   <meta name="description" content="One-sentence description." />
   <meta property="og:title" content="Essay Title" />
   <meta property="og:description" content="One-sentence description." />
   <meta property="og:url" content="https://paradoxofacceptance.xyz/mindfulness-essays/<slug>/" />
   <meta property="og:type" content="article" />
   ```

3. **Add to the index** — add a card/link in `mindfulness-essays/index.html`.

4. **Update `feed.xml`** — add a new `<item>` block at the top of the `<channel>`:

   ```xml
   <item>
     <title>Essay Title</title>
     <link>https://paradoxofacceptance.xyz/mindfulness-essays/<slug>/</link>
     <guid isPermaLink="true">https://paradoxofacceptance.xyz/mindfulness-essays/<slug>/</guid>
     <description>One-sentence description.</description>
     <pubDate>Day, DD Mon YYYY 00:00:00 +0000</pubDate>
   </item>
   ```

5. **Update `sitemap.xml`** — add the new URL.

6. **Commit and push:**

   ```bash
   git add mindfulness-essays/<slug>/ mindfulness-essays/index.html feed.xml sitemap.xml
   git commit -m "essay: add <slug>"
   git push origin main
   ```

The essay is live at `https://paradoxofacceptance.xyz/mindfulness-essays/<slug>/` within ~1 minute.

---

## 5. Admin Pages

| Page | URL | Auth | What it does |
|---|---|---|---|
| Newsletter send | `/admin/newsletter/` | `ADMIN_SECRET` (browser prompt) | Compose and send newsletters via Resend |
| Site stats | `/admin/stats/` | `ADMIN_SECRET` (browser prompt) | Page view analytics |

Both pages are static HTML served by GitHub Pages. Auth is client-side (ADMIN_SECRET checked in the browser).

---

## 6. Acceptance Pass Contract Operations

The contract is deployed on Base mainnet at `0x9691107411AFB05b81CfDE537Efc4a00b9b1bB69`.

### Check membership

```bash
cast call $CONTRACT_ADDRESS "isMember(address)(bool)" $WALLET_ADDRESS --rpc-url https://mainnet.base.org
```

### Get total minted

```bash
cast call $CONTRACT_ADDRESS "totalMinted()(uint256)" --rpc-url https://mainnet.base.org
```

### Pause / unpause minting

```bash
cast send $CONTRACT_ADDRESS "pause()" --rpc-url https://mainnet.base.org --private-key $DEPLOYER_PRIVATE_KEY
cast send $CONTRACT_ADDRESS "unpause()" --rpc-url https://mainnet.base.org --private-key $DEPLOYER_PRIVATE_KEY
```

Explorer: https://basescan.org/address/0x9691107411AFB05b81CfDE537Efc4a00b9b1bB69

---

## 7. Common Issues

| Symptom | Likely cause | Fix |
|---|---|---|
| Newsletter sends fail with auth error | `RESEND_API_KEY` wrong or expired | Regenerate at resend.com → API Keys |
| Full-list send blocked | `ALLOW_FULL_LIST_SEND` not set | Get Nick's approval, then set `ALLOW_FULL_LIST_SEND=true` and restart server |
| Pass mint fails | Gas sponsorship disabled or wrong chain | Check Privy dashboard → Embedded Wallets → Gas Sponsorship for Base |
| Pass UI shows wrong contract | `VITE_CONTRACT_ADDRESS` mismatch | Verify `pass-src/.env` matches mainnet address, rebuild and redeploy |
| Admin page rejects secret | `ADMIN_SECRET` changed | Update the secret in `newsletter/.env`, restart server |
| Essay not appearing in RSS feed | `feed.xml` not updated | Add `<item>` block to `feed.xml` and push |
| New essay returns 404 | Missing folder/slug mismatch | Ensure `mindfulness-essays/<slug>/index.html` exists and slug matches the URL |
| Unsubscribe links broken | `UNSUBSCRIBE_SECRET` changed after link generation | Do not rotate `UNSUBSCRIBE_SECRET` — existing tokens will become invalid |
