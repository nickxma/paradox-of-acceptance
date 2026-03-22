/**
 * Route mock helpers — intercept API calls with Playwright's route interceptor.
 *
 * All mocks target the cron Vercel API running at CRON_BASE_URL (default localhost:3100).
 * The pass React app uses VITE_API_BASE_URL which maps to the same origin.
 */

import type { Page } from '@playwright/test';

const API = process.env.CRON_BASE_URL ?? 'http://localhost:3100';

// ── Subscription status ───────────────────────────────────────────────────────

export interface SubscriptionStatus {
  isSubscriber?: boolean;
  isTrialing?: boolean;
  trialEnd?: string | null;
  currentPeriodEnd?: string | null;
  last4?: string | null;
  lastTaxAmountCents?: number | null;
}

export async function mockSubscriptionStatus(page: Page, status: SubscriptionStatus = {}) {
  const body: SubscriptionStatus = {
    isSubscriber: false,
    isTrialing: false,
    trialEnd: null,
    currentPeriodEnd: null,
    last4: null,
    lastTaxAmountCents: null,
    ...status,
  };
  await page.route('**/api/stripe/subscription*', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  );
}

export async function mockNoSubscription(page: Page) {
  return mockSubscriptionStatus(page, { isSubscriber: false });
}

export async function mockTrialingSubscription(page: Page, daysLeft = 10) {
  const trialEnd = new Date(Date.now() + daysLeft * 24 * 60 * 60 * 1000).toISOString();
  const currentPeriodEnd = new Date(Date.now() + daysLeft * 24 * 60 * 60 * 1000).toISOString();
  return mockSubscriptionStatus(page, {
    isSubscriber: true,
    isTrialing: true,
    trialEnd,
    currentPeriodEnd,
    last4: '4242',
  });
}

export async function mockActiveSubscription(page: Page) {
  const currentPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return mockSubscriptionStatus(page, {
    isSubscriber: true,
    isTrialing: false,
    trialEnd: null,
    currentPeriodEnd,
    last4: '4242',
  });
}

// ── On-chain membership (always returns false in tests — rely on Stripe) ────

export async function mockNoOnChainMembership(page: Page) {
  // The publicClient.readContract call goes to an RPC — block it gracefully
  await page.route('https://**/*.arbitrum.io/**', route => route.abort());
  await page.route('https://**/*.base.org/**', route => route.abort());
  await page.route('https://mainnet.infura.io/**', route => route.abort());
  await page.route('https://public.stackup.sh/**', route => route.abort());
}

// ── Stripe checkout ───────────────────────────────────────────────────────────

export async function mockStripeCheckout(page: Page, checkoutUrl = 'https://checkout.stripe.com/c/pay/test_session_123') {
  await page.route('**/api/stripe/checkout', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: checkoutUrl }) })
  );
}

export async function mockStripeCheckoutInvalidPromo(page: Page) {
  await page.route('**/api/stripe/checkout', route =>
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_promo_code' }) })
  );
}

// ── Stripe portal ─────────────────────────────────────────────────────────────

export async function mockStripePortal(page: Page, portalUrl = 'https://billing.stripe.com/p/session/test_portal_123') {
  await page.route('**/api/stripe/portal', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: portalUrl }) })
  );
}

// ── Promo code validation ─────────────────────────────────────────────────────

export async function mockValidPromo(page: Page, percentOff = 20) {
  await page.route('**/api/stripe/validate-promo', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ valid: true, promotionCodeId: 'promo_test123', percentOff, amountOff: null, currency: null, name: 'TESTCODE' }),
    })
  );
}

export async function mockInvalidPromo(page: Page) {
  await page.route('**/api/stripe/validate-promo', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: false }) })
  );
}

// ── Cancel survey ─────────────────────────────────────────────────────────────

export async function mockCancelSurvey(page: Page) {
  await page.route('**/api/subscriptions/cancel-survey', route =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  );
}
