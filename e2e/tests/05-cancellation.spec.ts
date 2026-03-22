/**
 * Test 5: Cancellation — exit survey + churn event.
 *
 * Clicking "Cancel subscription" shows the CancelSurveyModal before redirecting
 * to the Stripe portal. The survey POSTs to /api/subscriptions/cancel-survey.
 *
 * Covers:
 *   a) Cancel button opens survey modal
 *   b) Survey has radio options and a "Continue to cancel" CTA
 *   c) Submitting survey POSTs reason to cancel-survey endpoint
 *   d) After submit, portal API is called (redirect to Stripe portal)
 *   e) "Skip" goes directly to portal without POSTing survey
 */

import { test, expect } from '@playwright/test';
import { injectAuth, TEST_WALLET } from '../helpers/auth.js';
import { mockActiveSubscription, mockNoOnChainMembership, mockStripePortal } from '../helpers/mock-api.js';

const PASS_URL = process.env.PLAYWRIGHT_PASS_URL ?? 'http://localhost:4201';

test.describe('Cancellation exit survey', () => {
  test.beforeEach(async ({ page }) => {
    await injectAuth(page, { authenticated: true, walletAddress: TEST_WALLET });
    await mockActiveSubscription(page);
    await mockNoOnChainMembership(page);
    // Block Stripe portal navigation
    await page.route('https://billing.stripe.com/**', route => route.abort('aborted'));
  });

  test('Cancel button opens the exit survey modal', async ({ page }) => {
    await page.goto(`${PASS_URL}/pass/`);

    await expect(page.getByTestId('cancel-subscription-btn')).toBeVisible();
    await page.getByTestId('cancel-subscription-btn').click();

    await expect(page.getByTestId('cancel-survey-modal')).toBeVisible();
    await expect(page.getByTestId('cancel-survey-form')).toBeVisible();
  });

  test('survey submit POSTs reason and then calls portal', async ({ page }) => {
    let surveyBody: unknown = null;
    let portalCalled = false;

    await page.route('**/api/subscriptions/cancel-survey', async route => {
      surveyBody = await route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.route('**/api/stripe/portal', async route => {
      portalCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: 'https://billing.stripe.com/p/session/test' }),
      });
    });

    await page.goto(`${PASS_URL}/pass/`);
    await page.getByTestId('cancel-subscription-btn').click();

    // Select "Too expensive"
    await page.getByTestId('cancel-reason-too_expensive').check();
    await expect(page.getByTestId('cancel-survey-submit-btn')).toBeEnabled();
    await page.getByTestId('cancel-survey-submit-btn').click();

    // Survey POST should contain the reason
    await expect.poll(() => surveyBody, { timeout: 5000 }).toMatchObject({
      walletAddress: TEST_WALLET,
      reason: 'too_expensive',
    });

    // Portal should be called after survey
    await expect.poll(() => portalCalled, { timeout: 5000 }).toBe(true);
  });

  test('"Other" reason shows free-text textarea', async ({ page }) => {
    await page.route('**/api/subscriptions/cancel-survey', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    );
    await page.route('**/api/stripe/portal', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: 'https://billing.stripe.com/p/session/test' }) })
    );

    await page.goto(`${PASS_URL}/pass/`);
    await page.getByTestId('cancel-subscription-btn').click();

    await page.getByTestId('cancel-reason-other').check();
    await expect(page.getByTestId('cancel-reason-detail')).toBeVisible();

    await page.getByTestId('cancel-reason-detail').fill('The content is not what I expected.');
    await page.getByTestId('cancel-survey-submit-btn').click();
  });

  test('Skip bypasses survey and calls portal directly', async ({ page }) => {
    let surveyCalled = false;
    let portalCalled = false;

    await page.route('**/api/subscriptions/cancel-survey', async route => {
      surveyCalled = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.route('**/api/stripe/portal', async route => {
      portalCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: 'https://billing.stripe.com/p/session/test' }),
      });
    });

    await page.goto(`${PASS_URL}/pass/`);
    await page.getByTestId('cancel-subscription-btn').click();
    await page.getByTestId('cancel-survey-skip-btn').click();

    await expect.poll(() => portalCalled, { timeout: 5000 }).toBe(true);
    expect(surveyCalled).toBe(false);
  });

  test('submit button disabled until a reason is selected', async ({ page }) => {
    await page.goto(`${PASS_URL}/pass/`);
    await page.getByTestId('cancel-subscription-btn').click();

    await expect(page.getByTestId('cancel-survey-submit-btn')).toBeDisabled();

    await page.getByTestId('cancel-reason-not_using').check();
    await expect(page.getByTestId('cancel-survey-submit-btn')).toBeEnabled();
  });
});
