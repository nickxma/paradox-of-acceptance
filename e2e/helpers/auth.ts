/**
 * Auth helpers — inject mock Privy state via window.__PRIVY_MOCK.
 *
 * The pass-src app renders MockAuthBridge (instead of PrivyProvider) when
 * VITE_PRIVY_APP_ID is empty. MockAuthBridge reads from window.__PRIVY_MOCK
 * on mount, so we inject it before page load via page.addInitScript.
 */

import type { Page } from '@playwright/test';

export const TEST_WALLET = '0x1234567890123456789012345678901234567890';

export interface MockAuth {
  ready?: boolean;
  authenticated?: boolean;
  walletAddress?: string;
}

/**
 * Inject mock auth state. Must be called before page.goto().
 * Defaults to authenticated with TEST_WALLET.
 */
export function injectAuth(page: Page, opts: MockAuth = {}) {
  const {
    ready = true,
    authenticated = true,
    walletAddress = TEST_WALLET,
  } = opts;

  return page.addInitScript(`
    window.__PRIVY_MOCK = {
      ready: ${ready},
      authenticated: ${authenticated},
      user: ${authenticated ? JSON.stringify({ id: 'test-user', wallet: { address: walletAddress } }) : 'null'},
      wallets: ${authenticated ? JSON.stringify([{ address: walletAddress }]) : '[]'},
      login: function() {},
      logout: function() { return Promise.resolve(); },
    };
  `);
}

/** Inject unauthenticated state (shows UnauthenticatedView). */
export function injectUnauthenticated(page: Page) {
  return injectAuth(page, { authenticated: false });
}
