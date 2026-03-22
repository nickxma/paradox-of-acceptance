import React from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider } from '@privy-io/react-auth';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Sentry from '@sentry/react';
import { PRIVY_APP_ID, targetChain } from './lib/config.js';
import App from './App.jsx';
import './styles.css';

Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.VITE_CHAIN_ENV === 'production' ? 'production' : 'development',
  tracesSampleRate: import.meta.env.VITE_CHAIN_ENV === 'production' ? 0.1 : 1.0,
  integrations: [Sentry.browserTracingIntegration()],
});

const queryClient = new QueryClient();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
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
        <App />
      </PrivyProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
