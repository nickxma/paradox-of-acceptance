/**
 * Test 2: Stripe checkout → subscription active.
 *
 * Simulates the happy-path:
 *   a) User clicks "Subscribe with card →" → checkout API called → Stripe URL returned
 *   b) App redirects to Stripe checkout
 *   c) After checkout, user returns to /pass/?stripe_success=1
 *   d) The StripeSuccessPending screen is shown (webhook hasn't fired yet)
 *   e) Once membership status refreshes (webhook processed), MembersArea renders
 *
 * Note: Actual Stripe test-card flow (4242...) runs via the Stripe Dashboard or CLI.
 * This test validates the app's handling of the success redirect and state transition.
 *
 * Uses Stripe test mode. Set STRIPE_SECRET_KEY=sk_test_... and CRON_BASE_URL in .env.
 */

import { test, expect } from '@playwright/test';
import { injectAuth, TEST_WALLET } from '../helpers/auth.js';
import {
  mockNoSubscription,
  mockActiveSubscription,
  mockNoOnChainMembership,
  mockStripeCheckout,
} from '../helpers/mock-api.js';

const PASS_URL = process.env.PLAYWRIGHT_PASS_URL ?? 'http://localhost:4201';

test.describe('Stripe checkout flow', () => {
  test('clicking Subscribe CTA calls checkout API and receives redirect URL', async ({ page }) => {
    await injectAuth(page, { authenticated: true, walletAddress: TEST_WALLET });
    await mockNoSubscription(page);
    await mockNoOnChainMembership(page);

    const checkoutUrl = 'https://checkout.stripe.com/c/pay/test_cs_abc123';
    let checkoutBody: unknown = null;

    await page.route('**/api/stripe/checkout', async route => {
      checkoutBody = await route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: checkoutUrl }),
      });
    });

    // Block navigation away from the app
    await page.route('https://checkout.stripe.com/**', route => route.abort('aborted'));

    await page.goto(`${PASS_URL}/pass/`);
    await expect(page.getByTestId('subscribe-with-card-btn')).toBeVisible();
    await page.getByTestId('subscribe-with-card-btn').click();

    // Checkout API was called with the correct wallet address
    await expect.poll(() => checkoutBody, { timeout: 5000 }).toMatchObject({
      walletAddress: TEST_WALLET,
    });
  });

  test('returning with ?stripe_success=1 shows pending confirmation screen', async ({ page }) => {
    await injectAuth(page, { authenticated: true, walletAddress: TEST_WALLET });
    // Still no subscription yet (webhook hasn't fired)
    await mockNoSubscription(page);
    await mockNoOnChainMembership(page);

    await page.goto(`${PASS_URL}/pass/?stripe_success=1`);

    await expect(page.getByTestId('stripe-success-pending')).toBeVisible();
    await expect(page.getByText('Subscription confirmed.')).toBeVisible();
  });

  test('after subscription activates, members area is shown', async ({ page }) => {
    await injectAuth(page, { authenticated: true, walletAddress: TEST_WALLET });
    // Subscription is now active (webhook fired)
    await mockActiveSubscription(page);
    await mockNoOnChainMembership(page);

    await page.goto(`${PASS_URL}/pass/`);

    await expect(page.getByTestId('members-area')).toBeVisible();
    await expect(page.getByTestId('subscription-section')).toBeVisible();
  });
});
