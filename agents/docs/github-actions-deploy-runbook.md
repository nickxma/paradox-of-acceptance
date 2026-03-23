# GitHub Actions Deploy Runbook — Paradox of Acceptance

> **Purpose:** Enable automatic deployment to GitHub Pages on push to `main` for `paradoxofacceptance.xyz` and related repos.
> All workflow files are already committed locally. The only step blocking activation is a GitHub PAT with `workflow` scope.

---

## 1. One-Time Setup (Nick does this once)

### Step 1: Create a Fine-Grained GitHub Personal Access Token

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**
   - Direct URL: https://github.com/settings/personal-access-tokens/new

2. Configure the token:
   - **Token name:** `paperclip-agent-deploy` (or any memorable name)
   - **Expiration:** 90 days (or custom — note the expiry date)
   - **Resource owner:** `nickxma` (your personal account)
   - **Repository access:** Select repositories — choose `paradox-of-acceptance`, `nickxma.github.io`, and any other GitHub Pages repos

3. Set **Repository permissions:**
   | Permission | Level |
   |---|---|
   | Contents | Read and write |
   | Workflows | Read and write |
   | Pages | Read and write |
   | Actions | Read and write |

4. Click **Generate token** and copy the token value (shown only once).

### Step 2: Add the Token to Paperclip Agent Config

The agent needs this token to push workflow files to GitHub.

1. Open the Paperclip agent environment config (wherever `GITHUB_TOKEN` or `GH_TOKEN` is set for the local agent)
2. Set: `GITHUB_TOKEN=<your-fine-grained-token>`
3. Restart the agent or reload env vars

> Alternatively, configure it as a Git credential:
> ```bash
> git config --global credential.helper store
> echo "https://nickxma:<your-token>@github.com" >> ~/.git-credentials
> ```

---

## 2. What the Agent Does (Automated Steps)

Once the token is available, the agent will execute the following without further input:

### a. Push Committed Workflow Files

All workflow files are already written and locally committed. The agent runs:

```bash
cd /path/to/paradox-of-acceptance
git push origin main
```

This pushes `.github/workflows/deploy.yml` to GitHub.

### b. Verify GitHub Actions Triggers

The agent checks that the push triggered a workflow run:

```bash
gh run list --repo nickxma/paradox-of-acceptance --limit 5
```

Expected: a run appears with status `queued` or `in_progress` within ~30 seconds of push.

### c. Confirm Pages Deployment

The agent waits for the workflow run to complete and verifies:

```bash
gh run watch --repo nickxma/paradox-of-acceptance
```

Then checks the live site responds:

```bash
curl -I https://paradoxofacceptance.xyz
# Expected: HTTP 200
```

---

## 3. Verification Checklist

After setup, confirm each item:

- [ ] `.github/workflows/deploy.yml` is present in the repo on GitHub (not just locally)
- [ ] GitHub Actions shows a successful workflow run for the latest push to `main`
- [ ] GitHub Pages build status shows `Active` under repo → Settings → Pages
- [ ] `https://paradoxofacceptance.xyz` returns HTTP 200
- [ ] A test push to `main` (e.g., whitespace edit) triggers a new workflow run automatically
- [ ] The workflow run completes without errors (build + deploy jobs both green)

---

## 4. Troubleshooting

### Push rejected: "refusing to allow OAuth App to create or update workflow"
- The token lacks `workflow` scope. Regenerate with the permissions in Step 1.

### GitHub Actions not triggering
- Confirm the workflow file is on the `main` branch (not a feature branch)
- Confirm GitHub Pages is enabled: repo → Settings → Pages → Source must be **GitHub Actions**

### Pages not updating after successful deploy
- Check the `deploy` job logs in GitHub Actions — the `deploy-pages` step may have a permission error
- Confirm the repo's Pages source is set to **GitHub Actions** (not "Deploy from a branch")

### Token expired
- Repeat Step 1 to generate a new token and update the agent config in Step 2

---

## 5. Affected Repos

| Repo | URL | Workflow file |
|---|---|---|
| `paradox-of-acceptance` | https://paradoxofacceptance.xyz | `.github/workflows/deploy.yml` |
| `nickxma.github.io` | https://nickxma.github.io | TBD — needs workflow file |

---

## 6. Related Issues

- [OLU-110](/OLU/issues/OLU-110) — Parent: CI/CD and deploy pipeline improvements
- [OLU-116](/OLU/issues/OLU-116) — GitHub Actions auto-deploy (blocked on PAT)
- [OLU-595](/OLU/issues/OLU-595) — This runbook

---

*Last updated: 2026-03-23*
