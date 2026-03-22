import React, { useState, useCallback } from 'react';
import { API_BASE_URL } from '../lib/config.js';

export default function MembersArea({ walletAddress, isStripeSubscriber, stripeDetails }) {
  return (
    <>
      <div className="pass-hero">
        <div className="member-badge">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Member
        </div>
        <h1 className="pass-headline">The Inner Work</h1>
        <p className="pass-subtitle">
          Members-only material. Practices, notes, and drafts that haven't
          been published on the public site.
        </p>
      </div>

      <div className="members-section">
        <div className="members-label">For Members</div>
        <div className="members-content">

          <h3>On sitting with what you'd rather not</h3>
          <p>
            Most meditation instructions tell you to observe without judgment.
            That's the easy version. The harder version: observe while the judgment
            is already happening, and notice what it's protecting you from.
          </p>
          <p>
            The paradox shows up here. You can't force acceptance — but you can
            stop pretending you've already arrived at it. The space between
            "I should accept this" and "I actually do" is where the real practice lives.
          </p>

          <h3>Three questions for the cushion</h3>
          <p>
            These aren't koans. They're practical questions you can bring into any
            sitting practice. They don't have answers — they have effects.
          </p>
          <blockquote>
            What am I trying to fix right now?
          </blockquote>
          <blockquote>
            What would happen if nothing needed to change?
          </blockquote>
          <blockquote>
            Where in my body does "trying" live?
          </blockquote>
          <p>
            Sit with one for a week. Don't analyze it. Let it dissolve on its own schedule.
          </p>

          <h3>Notes on the observer problem</h3>
          <p>
            Every contemplative tradition eventually runs into the same structural
            problem: who's watching? If you can observe your thoughts, who's observing
            the observer? And if you find that observer — who noticed?
          </p>
          <p>
            This isn't philosophy. It's what happens in practice when you pay attention
            carefully enough. The infinite regress isn't a bug. It's the practice
            deconstructing its own scaffolding.
          </p>
          <p>
            The best teachers don't answer this question. They point you toward the
            experience of the question dissolving.
          </p>

        </div>
      </div>

      {isStripeSubscriber && (
        <SubscriptionSection walletAddress={walletAddress} stripeDetails={stripeDetails} />
      )}

      <div className="mint-stats">
        Connected as {walletAddress?.slice(0, 6)}...{walletAddress?.slice(-4)}
      </div>
    </>
  );
}

function SubscriptionSection({ walletAddress, stripeDetails }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleManage = useCallback(async () => {
    if (!walletAddress || !API_BASE_URL) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}/api/stripe/portal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to open portal');
      }
      const { url } = await res.json();
      if (url) {
        window.location.href = url;
      } else {
        throw new Error('No portal URL returned');
      }
    } catch (err) {
      console.error('Portal error:', err);
      setError('Could not open subscription portal. Please try again.');
      setLoading(false);
    }
  }, [walletAddress]);

  const renewalDate = stripeDetails?.currentPeriodEnd
    ? new Date(stripeDetails.currentPeriodEnd).toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return (
    <div className="subscription-section">
      <div className="members-label" style={{ marginBottom: 16 }}>Subscription</div>
      <div className="subscription-row">
        <span className="subscription-key">Plan</span>
        <span className="subscription-val">Pro</span>
      </div>
      {renewalDate && (
        <div className="subscription-row">
          <span className="subscription-key">Renews</span>
          <span className="subscription-val">{renewalDate}</span>
        </div>
      )}
      {stripeDetails?.last4 && (
        <div className="subscription-row">
          <span className="subscription-key">Card</span>
          <span className="subscription-val">•••• {stripeDetails.last4}</span>
        </div>
      )}
      <div style={{ marginTop: 20 }}>
        <button
          className="btn-secondary"
          onClick={handleManage}
          disabled={loading}
          style={{ fontSize: 13 }}
        >
          {loading ? (
            <>
              <span className="spinner" style={{ width: 12, height: 12, borderColor: '#999', borderTopColor: 'transparent' }} />
              {' '}Opening...
            </>
          ) : (
            'Manage subscription →'
          )}
        </button>
      </div>
      {error && <p className="status-line error" style={{ marginTop: 10 }}>{error}</p>}
    </div>
  );
}
