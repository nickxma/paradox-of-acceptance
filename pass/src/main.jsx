import React from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider } from '@privy-io/react-auth';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PRIVY_APP_ID, targetChain } from './lib/config.js';
import App from './App.jsx';
import './styles.css';

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
