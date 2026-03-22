/**
 * Test 7: Promo code at checkout.
 *
 * The MintFlow component has a "Have a promo code?" toggle that reveals an
 * input + Apply button. On submit, it calls /api/stripe/validate-promo.
 *
 * Covers:
 *   a) Promo code input is hidden by default
 *   b) Toggling shows the input
 *   c) Applying a valid code shows success message with discount info
 *   d) Applying an invalid code shows error message
 *   e) After a valid code, checkout is called with the promoCode field
 */

import { test, expect } from '@playwright/test';
import { injectAuth, TEST_WALLET } from '../helpers/auth.js';
import { mockNoSubscription, mockNoOnChainMembership, mockValidPromo, mockInvalidPromo } from '../helpers/mock-api.js';

const PASS_URL = process.env.PLAYWRIGHT_PASS_URL ?? 'http://localhost:4201';

test.describe('Promo code at checkout', () => {
  test.beforeEach(async ({ page }) => {
    await injectAuth(page, { authenticated: true, walletAddress: TEST_WALLET });
    await mockNoSubscription(page);
    await mockNoOnChainMembership(page);
  });

  test('promo code input is hidden by default', async ({ page }) => {
    await page.goto(`${PASS_URL}/pass/`);
    await expect(page.getByTestId('promo-code-input')).not.toBeVisible();
  });

  test('clicking "Have a promo code?" reveals the input', async ({ page }) => {
    await page.goto(`${PASS_URL}/pass/`);
    await page.getByText('Have a promo code?').click();
    await expect(page.getByTestId('promo-code-input')).toBeVisible();
  });

  test('valid promo code shows success with discount percentage', async ({ page }) => {
    await mockValidPromo(page, 20);

    await page.goto(`${PASS_URL}/pass/`);
    await page.getByText('Have a promo code?').click();
    await page.getByTestId('promo-code-input').fill('TESTCODE');
    await page.getByTestId('promo-apply-btn').click();

    await expect(page.getByTestId('promo-success')).toBeVisible();
    await expect(page.getByTestId('promo-success')).toContainText('20% off');
  });

  test('invalid promo code shows error message', async ({ page }) => {
    await mockInvalidPromo(page);

    await page.goto(`${PASS_URL}/pass/`);
    await page.getByText('Have a promo code?').click();
    await page.getByTestId('promo-code-input').fill('BADCODE');
    await page.getByTestId('promo-apply-btn').click();

    await expect(page.getByTestId('promo-error')).toBeVisible();
    await expect(page.getByTestId('promo-error')).toContainText('Invalid or expired promo code.');
  });

  test('checkout includes promoCode when a valid promo is applied', async ({ page }) => {
    await mockValidPromo(page, 20);

    let checkoutBody: unknown = null;
    await page.route('**/api/stripe/checkout', async route => {
      checkoutBody = await route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/test_with_promo' }),
      });
    });
    await page.route('https://checkout.stripe.com/**', route => route.abort('aborted'));

    await page.goto(`${PASS_URL}/pass/`);
    await page.getByText('Have a promo code?').click();
    await page.getByTestId('promo-code-input').fill('TESTCODE');
    await page.getByTestId('promo-apply-btn').click();

    await expect(page.getByTestId('promo-success')).toBeVisible();

    await page.getByTestId('subscribe-with-card-btn').click();

    await expect.poll(() => checkoutBody, { timeout: 5000 }).toMatchObject({
      walletAddress: TEST_WALLET,
      promoCode: 'TESTCODE',
    });
  });

  test('apply button is disabled until code is entered', async ({ page }) => {
    await page.goto(`${PASS_URL}/pass/`);
    await page.getByText('Have a promo code?').click();
    await expect(page.getByTestId('promo-apply-btn')).toBeDisabled();

    await page.getByTestId('promo-code-input').fill('A');
    await expect(page.getByTestId('promo-apply-btn')).toBeEnabled();
  });
});
