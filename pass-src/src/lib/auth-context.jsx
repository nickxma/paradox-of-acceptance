/**
 * AuthContext — unified auth interface for the pass React app.
 *
 * In production, PrivyAuthBridge reads real Privy state into this context.
 * In E2E test mode (VITE_PRIVY_APP_ID not set), MockAuthBridge reads
 * from window.__PRIVY_MOCK instead.
 *
 * Components use useAuthContext() and useWalletsContext() rather than
 * calling @privy-io/react-auth hooks directly.
 */

import React, { createContext, useContext, useState, useEffect } from 'react';

// ── Auth context ─────────────────────────────────────────────────────────────

export const DEFAULT_AUTH = {
  ready: false,
  authenticated: false,
  user: null,
  login: () => {},
  logout: async () => {},
};

export const AuthContext = createContext(DEFAULT_AUTH);
export const useAuthContext = () => useContext(AuthContext);

// ── Wallets context ──────────────────────────────────────────────────────────

export const WalletsContext = createContext({ wallets: [] });
export const useWalletsContext = () => useContext(WalletsContext);

// ── Mock bridge (E2E test mode) ───────────────────────────────────────────────
// Reads from window.__PRIVY_MOCK injected by Playwright via page.addInitScript.

export function MockAuthBridge({ children }) {
  const [auth, setAuth] = useState(() => {
    if (typeof window !== 'undefined' && window.__PRIVY_MOCK) {
      const m = window.__PRIVY_MOCK;
      return {
        ready: m.ready ?? false,
        authenticated: m.authenticated ?? false,
        user: m.user ?? null,
        login: m.login ?? DEFAULT_AUTH.login,
        logout: m.logout ?? DEFAULT_AUTH.logout,
      };
    }
    return DEFAULT_AUTH;
  });

  const [wallets, setWallets] = useState(() => {
    if (typeof window !== 'undefined' && window.__PRIVY_MOCK?.wallets) {
      return window.__PRIVY_MOCK.wallets;
    }
    return [];
  });

  useEffect(() => {
    const m = window.__PRIVY_MOCK;
    if (!m) return;
    setAuth({
      ready: m.ready ?? true,
      authenticated: m.authenticated ?? false,
      user: m.user ?? null,
      login: m.login ?? DEFAULT_AUTH.login,
      logout: m.logout ?? DEFAULT_AUTH.logout,
    });
    setWallets(m.wallets ?? []);
  }, []);

  return (
    <AuthContext.Provider value={auth}>
      <WalletsContext.Provider value={{ wallets }}>
        {children}
      </WalletsContext.Provider>
    </AuthContext.Provider>
  );
}
