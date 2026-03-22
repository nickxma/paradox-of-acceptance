/**
 * Playwright config — paradoxofacceptance.xyz pre-launch regression suite.
 *
 * Two server setup:
 *   1. Static site (serve the root project dir) — HTML pages, /pricing, /mindfulness-essays, etc.
 *   2. Pass React SPA dev server (pass-src) in E2E mode — VITE_PRIVY_APP_ID empty → MockAuthBridge
 *   3. Vercel cron API dev server (optional) — set CRON_BASE_URL env var to point at a running instance
 *
 * Environment variables:
 *   PLAYWRIGHT_BASE_URL    — override static site URL (e.g. https://paradoxofacceptance.xyz)
 *   CRON_BASE_URL          — Vercel cron API base URL (default: http://localhost:3100)
 *   STRIPE_SECRET_KEY      — Stripe test key (for webhook signature tests, scenario 6)
 *   STRIPE_WEBHOOK_SECRET  — Stripe webhook signing secret (for scenario 6)
 */

import { defineConfig, devices } from '@playwright/test';
import path from 'path';

const STATIC_PORT = 4200;
const PASS_DEV_PORT = 4201;

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${STATIC_PORT}`;
const passURL = process.env.PLAYWRIGHT_PASS_URL ?? `http://localhost:${PASS_DEV_PORT}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : [['html', { open: 'never' }]],

  use: {
    baseURL,
    trace: 'on-first-retry',
    // Inject the cron API base URL + pass URL so tests can access them
    extraHTTPHeaders: {},
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : [
        // 1. Static site server (serves the entire paradox-of-acceptance dir)
        {
          command: `npx serve ${path.resolve(__dirname, '..')} --listen ${STATIC_PORT} --no-clipboard`,
          url: `http://localhost:${STATIC_PORT}`,
          reuseExistingServer: !process.env.CI,
          timeout: 30_000,
        },
        // 2. Pass React SPA in E2E mode (MockAuthBridge — no PRIVY_APP_ID)
        {
          command: `npx vite --port ${PASS_DEV_PORT} --host`,
          cwd: path.resolve(__dirname, '../pass-src'),
          url: `http://localhost:${PASS_DEV_PORT}/pass/`,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
          env: {
            VITE_PRIVY_APP_ID: '',              // Triggers MockAuthBridge
            VITE_API_BASE_URL: process.env.CRON_BASE_URL ?? 'http://localhost:3100',
            VITE_CONTRACT_ADDRESS: '',           // Skip on-chain checks in tests
            VITE_CHAIN_ENV: 'testnet',
          },
        },
      ],
});
