import React, { useEffect, useState } from 'react';
import * as Sentry from '@sentry/react';
import { useAuthContext, useWalletsContext } from './lib/auth-context.jsx';
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
  const { ready, authenticated, login, logout, user } = useAuthContext();
  const { wallets } = useWalletsContext();
  const walletAddress = wallets?.[0]?.address;
  const { isMember, isStripeSubscriber, isTrialing, stripeDetails, isLoading: memberLoading, refetch } = useMembershipStatus(walletAddress);

  // Check if we just returned from a successful Stripe checkout
  const params = new URLSearchParams(window.location.search);
  const stripeSuccess = params.get('stripe_success') === '1';
  const subscriptionUpdated = params.get('subscription_updated') === '1';

  // Toast state for post-portal return
  const [showToast, setShowToast] = useState(false);

  useEffect(() => {
    if (subscriptionUpdated) {
      // Refetch membership to get fresh data
      refetch();
      setShowToast(true);
      // Clean the query param from the URL without a page reload
      const url = new URL(window.location.href);
      url.searchParams.delete('subscription_updated');
      window.history.replaceState({}, '', url.toString());
      // Auto-dismiss after 4s
      const t = setTimeout(() => setShowToast(false), 4000);
      return () => clearTimeout(t);
    }
  }, []); // run once on mount

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
        ) : stripeSuccess && !isMember ? (
          <StripeSuccessPending />
        ) : isMember ? (
          <MembersArea
            walletAddress={walletAddress}
            isStripeSubscriber={isStripeSubscriber}
            isTrialing={isTrialing}
            stripeDetails={stripeDetails}
          />
        ) : (
          <MintFlow walletAddress={walletAddress} />
        )}
      </div>

      <Footer />

      {showToast && (
        <div className="toast" data-testid="subscription-updated-toast">Subscription updated.</div>
      )}
    </>
  );
}

function UnauthenticatedView({ onLogin }) {
  return (
    <>
      <div className="pass-hero" data-testid="unauthenticated-hero">
        <h1 className="pass-headline">Acceptance Pass</h1>
        <p className="pass-subtitle">
          A membership credential for the Paradox of Acceptance community.
          Connect to mint your pass or subscribe with a card.
        </p>
      </div>

      <div className="pass-card">
        <div className="pass-card-label">What you get</div>
        <p className="pass-card-text">
          Access to members-only practices, early drafts, and deeper material
          that doesn't appear on the public site.
        </p>
        <p className="pass-card-text">
          Free to mint on-chain, or subscribe with a card — no crypto required.
        </p>
      </div>

      <div style={{ textAlign: 'center' }}>
        <button className="btn-primary" onClick={onLogin} data-testid="get-access-btn">
          Get access
        </button>
      </div>
    </>
  );
}

// Shown when stripe_success=1 but the webhook hasn't processed yet
function StripeSuccessPending() {
  return (
    <>
      <div className="pass-hero">
        <h1 className="pass-headline">Subscription confirmed.</h1>
        <p className="pass-subtitle">
          Your payment was successful. Access is being activated — this usually takes a few seconds.
        </p>
      </div>
      <div className="pass-card">
        <p className="pass-card-text">
          If the members area doesn't appear automatically, refresh the page in a moment.
        </p>
      </div>
      <div style={{ textAlign: 'center' }}>
        <button className="btn-primary" onClick={() => window.location.reload()}>
          Refresh
        </button>
      </div>
    </>
  );
}
