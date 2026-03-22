import React from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Sentry from '@sentry/react';
import { PRIVY_APP_ID, targetChain } from './lib/config.js';
import { AuthContext, WalletsContext, MockAuthBridge } from './lib/auth-context.jsx';
import App from './App.jsx';
import './styles.css';

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.VITE_CHAIN_ENV === 'production' ? 'production' : 'development',
  tracesSampleRate: import.meta.env.VITE_CHAIN_ENV === 'production' ? 0.1 : 1.0,
  integrations: [Sentry.browserTracingIntegration()],
});

// Reads real Privy state into AuthContext + WalletsContext for production.
function PrivyBridge({ children }) {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets } = useWallets();
  return (
    <AuthContext.Provider value={{ ready, authenticated, user, login, logout }}>
      <WalletsContext.Provider value={{ wallets }}>
        {children}
      </WalletsContext.Provider>
    </AuthContext.Provider>
  );
}

const queryClient = new QueryClient();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {PRIVY_APP_ID ? (
        <PrivyProvider
          appId={PRIVY_APP_ID}
          config={{
            appearance: {
              theme: 'light',
              accentColor: '#111111',
              logo: null,
              showWalletLoginFirst: false,
            },
            loginMethods: ['email', 'wallet'],
            embeddedWallets: {
              createOnLogin: 'users-without-wallets',
            },
            defaultChain: targetChain,
            supportedChains: [targetChain],
          }}
        >
          <PrivyBridge>
            <App />
          </PrivyBridge>
        </PrivyProvider>
      ) : (
        // E2E test mode: no Privy app ID — use MockAuthBridge backed by window.__PRIVY_MOCK
        <MockAuthBridge>
          <App />
        </MockAuthBridge>
      )}
    </QueryClientProvider>
  </React.StrictMode>
);
