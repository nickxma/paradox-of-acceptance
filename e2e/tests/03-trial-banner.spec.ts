/**
 * Test 3: Trial countdown banner.
 *
 * Subscribers in `trialing` status see a countdown banner in the subscription
 * section showing "X days left" (or "Ends today" at 0 days).
 *
 * The banner reads from `trialEnd` in the subscription status API response.
 */

import { test, expect } from '@playwright/test';
import { injectAuth, TEST_WALLET } from '../helpers/auth.js';
import { mockNoOnChainMembership, mockSubscriptionStatus } from '../helpers/mock-api.js';

const PASS_URL = process.env.PLAYWRIGHT_PASS_URL ?? 'http://localhost:4201';

test.describe('Trial countdown banner', () => {
  test('shows correct days remaining for a 10-day trial', async ({ page }) => {
    await injectAuth(page, { authenticated: true, walletAddress: TEST_WALLET });
    await mockNoOnChainMembership(page);

    const daysLeft = 10;
    const trialEnd = new Date(Date.now() + daysLeft * 24 * 60 * 60 * 1000).toISOString();

    await mockSubscriptionStatus(page, {
      isSubscriber: true,
      isTrialing: true,
      trialEnd,
      currentPeriodEnd: trialEnd,
      last4: '4242',
    });

    await page.goto(`${PASS_URL}/pass/`);

    await expect(page.getByTestId('trial-countdown-banner')).toBeVisible();
    await expect(page.getByTestId('trial-days-left')).toContainText('10 days left');
  });

  test('shows correct text for a 1-day trial (singular "day")', async ({ page }) => {
    await injectAuth(page, { authenticated: true, walletAddress: TEST_WALLET });
    await mockNoOnChainMembership(page);

    const trialEnd = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString();

    await mockSubscriptionStatus(page, {
      isSubscriber: true,
      isTrialing: true,
      trialEnd,
      currentPeriodEnd: trialEnd,
    });

    await page.goto(`${PASS_URL}/pass/`);

    await expect(page.getByTestId('trial-days-left')).toContainText('1 day left');
  });

  test('shows "Ends today" when trial expires today', async ({ page }) => {
    await injectAuth(page, { authenticated: true, walletAddress: TEST_WALLET });
    await mockNoOnChainMembership(page);

    // Trial ends in less than 24h — Math.ceil rounds to 0
    const trialEnd = new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString(); // 1 hour

    await mockSubscriptionStatus(page, {
      isSubscriber: true,
      isTrialing: true,
      trialEnd,
      currentPeriodEnd: trialEnd,
    });

    await page.goto(`${PASS_URL}/pass/`);

    await expect(page.getByTestId('trial-days-left')).toContainText('Ends today');
  });

  test('no trial banner for an active (non-trialing) subscriber', async ({ page }) => {
    await injectAuth(page, { authenticated: true, walletAddress: TEST_WALLET });
    await mockNoOnChainMembership(page);

    const currentPeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await mockSubscriptionStatus(page, {
      isSubscriber: true,
      isTrialing: false,
      trialEnd: null,
      currentPeriodEnd,
      last4: '4242',
    });

    await page.goto(`${PASS_URL}/pass/`);

    await expect(page.getByTestId('members-area')).toBeVisible();
    await expect(page.getByTestId('trial-countdown-banner')).not.toBeVisible();
  });
});
