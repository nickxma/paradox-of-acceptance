import React from 'react';

export default function Nav({ authenticated, onLogin, onLogout, user }) {
  const displayAddress = user?.wallet?.address
    ? `${user.wallet.address.slice(0, 6)}...${user.wallet.address.slice(-4)}`
    : null;

  const displayEmail = user?.email?.address;

  return (
    <nav className="nav">
      <div style={{ display: 'flex', alignItems: 'center', gap: 48 }}>
        <a href="/" className="nav-logo">Paradox of Acceptance</a>
        <div className="nav-links">
          <a href="/#start-here">Tools</a>
          <a href="/mindfulness-essays/">Essays</a>
          <a href="/pass/" className="active">Pass</a>
          <a href="/pricing/">Pricing</a>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {authenticated ? (
          <>
            <span style={{ fontSize: 13, color: '#666' }}>
              {displayEmail || displayAddress}
            </span>
            <button
              onClick={onLogout}
              style={{
                fontSize: 12, color: '#999', cursor: 'pointer',
                background: 'none', border: 'none', fontFamily: 'inherit',
              }}
            >
              Sign out
            </button>
          </>
        ) : (
          <button
            onClick={onLogin}
            style={{
              fontSize: 13, fontWeight: 500, color: '#666', cursor: 'pointer',
              background: 'none', border: 'none', fontFamily: 'inherit',
            }}
          >
            Sign in
          </button>
        )}
      </div>
    </nav>
  );
}
