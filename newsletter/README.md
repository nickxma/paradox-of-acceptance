# Newsletter — paradoxofacceptance.xyz

Email platform: **Resend** (see rationale below).

## Setup (One-Time)

### 1. Create Resend Account
- Sign up at resend.com
- Start on Pro plan ($20/mo) — handles 50K emails/month, covers the 26K list

### 2. Verify Domain
In Resend dashboard → Domains → Add Domain → `paradoxofacceptance.xyz`

Add the DNS records Resend provides:
- **SPF**: TXT record on `paradoxofacceptance.xyz`
- **DKIM**: two TXT records (Resend provides exact values)
- **DMARC**: TXT record on `_dmarc.paradoxofacceptance.xyz` — use `v=DMARC1; p=none; rua=mailto:dmarc@paradoxofacceptance.xyz` to start

DNS changes propagate in minutes to hours. Resend will show "Verified" when done.

### 3. Create an Audience
Resend dashboard → Audiences → Create Audience → name it `Paradox of Acceptance`

Copy the Audience ID (looks like `78261eea-8f8b-4381-83c6-79fa7120f1cf`).

### 4. Get API Key
Resend dashboard → API Keys → Create API Key → Full Access

**Keep this secret.** Do not commit to the repo.

### 5. Configure env
```bash
cd newsletter
cp .env.example .env
# Edit .env — fill in RESEND_API_KEY, RESEND_AUDIENCE_ID, SEND_API_KEY, EMAIL_FROM
# Generate secrets: openssl rand -hex 32  (run twice — once for SEND_API_KEY, once for UNSUBSCRIBE_SECRET)
```

### 6. Install deps
```bash
npm install
```

### 7. Import the list
```bash
npm run import-list
```

Imports ~26,467 contacts from the CSV. Safe to re-run — Resend deduplicates by email.

---

## Send Pipeline (HTTP API)

The send pipeline is an HTTP server that Content Lead or agents call to trigger sends.

### Start the server

```bash
npm run server
# Listens on http://127.0.0.1:3200 (configure PORT in .env)
```

### Test send (single address — always safe)

```bash
curl -X POST http://127.0.0.1:3200/send \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $SEND_API_KEY" \
  -d '{
    "subject": "The Paradox of Acceptance",
    "essayUrl": "https://paradoxofacceptance.xyz/mindfulness-essays/paradox-of-acceptance/",
    "testEmail": "nick@example.com"
  }'
```

Or send markdown content directly:

```bash
curl -X POST http://127.0.0.1:3200/send \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $SEND_API_KEY" \
  -d '{
    "subject": "Essay title",
    "markdownBody": "# Essay Title\n\nParagraph text here...",
    "testEmail": "nick@example.com"
  }'
```

### Full-list send (requires Nick approval)

Before sending to the full 26K list, Nick must approve. Then:

1. Set `ALLOW_FULL_LIST_SEND=true` in `.env`
2. Restart the server
3. Call `/send` without `testEmail`:

```bash
curl -X POST http://127.0.0.1:3200/send \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $SEND_API_KEY" \
  -d '{
    "subject": "The Paradox of Acceptance",
    "essayUrl": "https://paradoxofacceptance.xyz/mindfulness-essays/paradox-of-acceptance/"
  }'
```

Returns `{ status: "sent", mode: "broadcast", broadcastId: "..." }`.
Resend processes the broadcast asynchronously — delivery stats appear in the Resend dashboard.

### Check broadcast status

```bash
curl http://127.0.0.1:3200/status/<broadcastId> \
  -H "X-Api-Key: $SEND_API_KEY"
```

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | None | Health check + config summary |
| `POST` | `/api/subscribe` | None (public) | Subscribe an email address |
| `GET` | `/api/unsubscribe?token=` | Token | Unsubscribe via HMAC token |
| `POST` | `/send` | X-Api-Key | Send newsletter (test or broadcast) |
| `GET` | `/status/:id` | X-Api-Key | Get broadcast delivery status |

All `/send` and `/status` endpoints require `X-Api-Key` header.

---

## Subscribe / Unsubscribe API

These are the public-facing endpoints for the subscription widget on the site.

### Subscribe

```bash
curl -X POST http://127.0.0.1:3200/api/subscribe \
  -H "Content-Type: application/json" \
  -d '{"email": "reader@example.com", "firstName": "Alex"}'
```

Returns:
```json
{ "status": "subscribed", "unsubscribeToken": "<token>" }
```

Store the `unsubscribeToken` to build an unsubscribe link:
```
https://paradoxofacceptance.xyz/unsubscribe?token=<token>
```
That page should call `GET /api/unsubscribe?token=<token>` (or proxy to it).

Resend deduplicates by email — safe to call for existing subscribers.

### Unsubscribe

```bash
curl "http://127.0.0.1:3200/api/unsubscribe?token=<token>"
```

Returns an HTML confirmation page. Embed in an iframe or redirect to it from your unsubscribe page.

The token is HMAC-SHA256 signed — tampered tokens are rejected with `400`.

### Embedding in newsletter emails

In the email HTML, use a link to your unsubscribe page:

```html
<a href="https://paradoxofacceptance.xyz/unsubscribe?token={{contactUnsubscribeToken}}">Unsubscribe</a>
```

When sending via the `/send` endpoint, generate the token for each recipient and substitute it into the HTML.
For **Broadcasts** (full-list sends), Resend handles unsubscribes automatically via `{{unsubscribe}}` — no token needed for those.

---

## Sending via Script (Legacy)

The original `send-newsletter.ts` script still works for manual sends via env vars:

```bash
SUBJECT="Your essay title" \
CONTENT_HTML="<p>Your HTML content here</p>" \
npm run send
```

**Important**: Do not run against the full list until Nick approves.

---

## Platform Rationale: Resend vs Buttondown

| Criterion | Resend | Buttondown |
|-----------|--------|------------|
| API-driven sends | ✅ First-class | ✅ REST API |
| List management | ✅ Audiences | ✅ Built-in |
| Unsubscribe handling | ✅ Auto in Broadcasts | ✅ Built-in |
| CAN-SPAM / GDPR | ✅ | ✅ |
| Open/click analytics | ✅ | ✅ |
| Custom subscription widget | ✅ Easy | ✅ Embed widget |
| Cost at 26K subscribers | ~$20/mo | ~$99/mo |
| React Email templates | ✅ First-class | ❌ |
| Fits existing Supabase setup | ✅ | ⚠️ |
| Developer control | ✅ Full | ⚠️ Partial |

**Decision: Resend**

- Costs ~$80/mo less at this list size
- Designed for API-driven/developer workflows (matches the planned send pipeline)
- Works naturally alongside the existing Supabase subscriber table
- Broadcasts handle CAN-SPAM unsubscribe automatically
- React Email integration for high-quality templates later

Buttondown is the better choice if you want a managed newsletter product with minimal code. Resend is better here because the parent project is building a custom send pipeline and has existing infrastructure.

---

## Analytics

Resend provides open rate, click rate, and unsubscribe data in the dashboard. For Grafana:
- Use Resend's webhook events (`email.opened`, `email.clicked`, `email.bounced`, `contact.unsubscribed`)
- Forward to a simple endpoint that writes to Supabase or Postgres
- Visualize in Grafana via the Supabase/Postgres datasource
