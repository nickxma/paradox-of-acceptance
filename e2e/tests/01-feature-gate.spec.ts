/**
 * Test 1: Free user hits Pro feature gate.
 *
 * An authenticated wallet holder with no membership sees the MintFlow
 * "Unlock the members area" screen. The "Subscribe with card →" CTA
 * triggers the checkout API.
 *
 * Covers:
 *   - Pass page shows gate for non-members
 *   - Gate UI has the expected headline and subscription CTA
 *   - CTA links to Stripe checkout (calls /api/stripe/checkout)
 */

import { test, expect } from '@playwright/test';
import { injectAuth, TEST_WALLET } from '../helpers/auth.js';
import { mockNoSubscription, mockNoOnChainMembership, mockStripeCheckout } from '../helpers/mock-api.js';

const PASS_URL = process.env.PLAYWRIGHT_PASS_URL ?? 'http://localhost:4201';

test.describe('Feature gate — non-member sees upgrade prompt', () => {
  test('authenticated non-member sees the MintFlow gate with subscribe CTA', async ({ page }) => {
    // No membership → MintFlow is shown (the "Pro feature gate")
    await injectAuth(page, { authenticated: true, walletAddress: TEST_WALLET });
    await mockNoSubscription(page);
    await mockNoOnChainMembership(page);

    // Prevent the checkout redirect from navigating away
    let checkoutCalled = false;
    await page.route('**/api/stripe/checkout', async route => {
      checkoutCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/test_session_123' }),
      });
    });

    await page.goto(`${PASS_URL}/pass/`);

    // The gate headline must be visible
    await expect(page.getByRole('heading', { name: 'Unlock the members area' })).toBeVisible();

    // Subscribe with card CTA must exist
    const subscribeCTA = page.getByTestId('subscribe-with-card-btn');
    await expect(subscribeCTA).toBeVisible();

    // Clicking the CTA calls /api/stripe/checkout
    // Intercept navigation to Stripe checkout URL
    await page.route('https://checkout.stripe.com/**', route => route.abort('aborted'));
    await subscribeCTA.click();

    // Checkout API must have been called
    await expect.poll(() => checkoutCalled, { timeout: 5000 }).toBe(true);
  });

  test('unauthenticated user sees connect prompt, not members area', async ({ page }) => {
    await injectAuth(page, { authenticated: false });

    await page.goto(`${PASS_URL}/pass/`);

    await expect(page.getByTestId('unauthenticated-hero')).toBeVisible();
    await expect(page.getByTestId('get-access-btn')).toBeVisible();
    await expect(page.getByTestId('members-area')).not.toBeVisible();
  });
});
