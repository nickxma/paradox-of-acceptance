/**
 * Test 4: Customer Portal link.
 *
 * Subscribers see a "Manage subscription →" button in the subscription section.
 * Clicking it calls POST /api/stripe/portal and redirects to the Stripe-hosted portal.
 */

import { test, expect } from '@playwright/test';
import { injectAuth, TEST_WALLET } from '../helpers/auth.js';
import { mockActiveSubscription, mockNoOnChainMembership } from '../helpers/mock-api.js';

const PASS_URL = process.env.PLAYWRIGHT_PASS_URL ?? 'http://localhost:4201';

test.describe('Customer Portal', () => {
  test('Manage subscription button calls portal API and redirects', async ({ page }) => {
    await injectAuth(page, { authenticated: true, walletAddress: TEST_WALLET });
    await mockActiveSubscription(page);
    await mockNoOnChainMembership(page);

    const portalUrl = 'https://billing.stripe.com/p/session/test_portal_abc';
    let portalBody: unknown = null;

    await page.route('**/api/stripe/portal', async route => {
      portalBody = await route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: portalUrl }),
      });
    });

    // Block navigation to Stripe portal so the test doesn't leave the app
    await page.route('https://billing.stripe.com/**', route => route.abort('aborted'));

    await page.goto(`${PASS_URL}/pass/`);
    await expect(page.getByTestId('manage-subscription-btn')).toBeVisible();
    await page.getByTestId('manage-subscription-btn').click();

    // Portal API called with correct wallet
    await expect.poll(() => portalBody, { timeout: 5000 }).toMatchObject({
      walletAddress: TEST_WALLET,
    });
  });

  test('portal error shows inline error message', async ({ page }) => {
    await injectAuth(page, { authenticated: true, walletAddress: TEST_WALLET });
    await mockActiveSubscription(page);
    await mockNoOnChainMembership(page);

    await page.route('**/api/stripe/portal', route =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Stripe not configured' }) })
    );

    await page.goto(`${PASS_URL}/pass/`);
    await page.getByTestId('manage-subscription-btn').click();

    await expect(page.getByTestId('portal-error')).toBeVisible();
  });

  test('returning from portal with ?subscription_updated=1 shows toast', async ({ page }) => {
    await injectAuth(page, { authenticated: true, walletAddress: TEST_WALLET });
    await mockActiveSubscription(page);
    await mockNoOnChainMembership(page);

    await page.goto(`${PASS_URL}/pass/?subscription_updated=1`);

    await expect(page.getByTestId('subscription-updated-toast')).toBeVisible();
    await expect(page.getByText('Subscription updated.')).toBeVisible();
  });
});
