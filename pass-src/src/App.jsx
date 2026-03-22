import React from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import * as Sentry from '@sentry/react';
import { useMembershipStatus } from './hooks/useMembershipStatus.js';
import MintFlow from './components/MintFlow.jsx';
import MembersArea from './components/MembersArea.jsx';
import Nav from './components/Nav.jsx';
import Footer from './components/Footer.jsx';

function AppErrorFallback({ error, resetError }) {
  return (
    <div style={{ textAlign: 'center', padding: '80px 24px' }}>
      <h2 style={{ marginBottom: '12px', fontSize: '20px', fontWeight: 600 }}>Something went wrong</h2>
      <p style={{ marginBottom: '24px', color: '#666', fontSize: '14px' }}>
        This error has been reported. Please try again.
      </p>
      <button
        onClick={resetError}
        style={{
          padding: '8px 20px',
          background: '#111',
          color: '#fff',
          border: 'none',
          borderRadius: '6px',
          cursor: 'pointer',
          fontSize: '14px',
        }}
      >
        Try again
      </button>
    </div>
  );
}

const AppWithErrorBoundary = Sentry.withErrorBoundary(AppInner, {
  fallback: AppErrorFallback,
});

export default function App() {
  return <AppWithErrorBoundary />;
}

function AppInner() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();
  const walletAddress = wallets?.[0]?.address;
  const { isMember, isLoading: memberLoading } = useMembershipStatus(walletAddress);

  if (!ready) {
    return (
      <>
        <Nav />
        <hr className="divider" />
        <div className="page">
          <div className="pass-hero">
            <p className="pass-subtitle">Loading...</p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Nav authenticated={authenticated} onLogin={login} onLogout={logout} user={user} />
      <hr className="divider" />

      <div className="page">
        {!authenticated ? (
          <UnauthenticatedView onLogin={login} />
        ) : memberLoading ? (
          <div className="pass-hero">
            <p className="pass-subtitle">Checking membership...</p>
          </div>
        ) : isMember ? (
          <MembersArea walletAddress={walletAddress} />
        ) : (
          <MintFlow walletAddress={walletAddress} />
        )}
      </div>

      <Footer />
    </>
  );
}

function UnauthenticatedView({ onLogin }) {
  return (
    <>
      <div className="pass-hero">
        <h1 className="pass-headline">Acceptance Pass</h1>
        <p className="pass-subtitle">
          A membership credential for the Paradox of Acceptance community.
          Connect to mint your pass and unlock members-only content.
        </p>
      </div>

      <div className="pass-card">
        <div className="pass-card-label">What you get</div>
        <p className="pass-card-text">
          The Acceptance Pass is a non-transferable membership credential on Ethereum (Base).
          It gives you access to members-only practices, early drafts, and deeper material
          that doesn't appear on the public site.
        </p>
        <p className="pass-card-text">
          Free to mint. No gas required. No speculation. Just membership.
        </p>
      </div>

      <div style={{ textAlign: 'center' }}>
        <button className="btn-primary" onClick={onLogin}>
          Get your Acceptance Pass
        </button>
      </div>
    </>
  );
}
