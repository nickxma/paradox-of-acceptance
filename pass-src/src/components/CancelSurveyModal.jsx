/**
 * CancelSurveyModal
 *
 * Shown when a subscriber clicks "Cancel subscription". Collects a cancellation
 * reason before redirecting to the Stripe Customer Portal.
 *
 * Props:
 *   walletAddress     — authenticated wallet
 *   onClose           — dismiss without proceeding
 *   onProceedToPortal — open the Stripe portal (handles the redirect)
 */

import React, { useState, useCallback } from 'react';
import { API_BASE_URL } from '../lib/config.js';

const REASONS = [
  { value: 'too_expensive', label: 'Too expensive' },
  { value: 'not_using', label: 'Not using it enough' },
  { value: 'missing_feature', label: 'Missing a feature I need' },
  { value: 'switching', label: 'Switching to something else' },
  { value: 'pausing', label: 'Just pausing' },
  { value: 'other', label: 'Other' },
];

export default function CancelSurveyModal({ walletAddress, onClose, onProceedToPortal }) {
  const [reason, setReason] = useState('');
  const [reasonDetail, setReasonDetail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!reason) return;

    setSubmitting(true);
    setError(null);

    try {
      if (API_BASE_URL) {
        await fetch(`${API_BASE_URL}/api/subscriptions/cancel-survey`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            walletAddress,
            reason,
            reasonDetail: reason === 'other' ? reasonDetail : undefined,
          }),
        });
        // Non-fatal — proceed to portal even if survey POST fails
      }
    } catch {
      // Swallow — survey submission is best-effort
    } finally {
      setSubmitting(false);
    }

    onProceedToPortal();
  }, [reason, reasonDetail, walletAddress, onProceedToPortal]);

  const handleSkip = useCallback(() => {
    onProceedToPortal();
  }, [onProceedToPortal]);

  return (
    <div
      data-testid="cancel-survey-modal"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Overlay */}
      <div
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0,0,0,0.45)',
        }}
      />

      {/* Modal box */}
      <div
        style={{
          position: 'relative',
          background: '#fff',
          maxWidth: 420,
          width: 'calc(100% - 48px)',
          padding: '40px 36px 32px',
          borderRadius: 6,
          boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
          zIndex: 1,
        }}
      >
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 14,
            right: 16,
            background: 'none',
            border: 'none',
            fontSize: 22,
            cursor: 'pointer',
            color: '#999',
            padding: '2px 6px',
            lineHeight: 1,
          }}
        >
          ×
        </button>

        <h2
          style={{
            fontFamily: 'Georgia, serif',
            fontSize: 20,
            fontWeight: 400,
            marginBottom: 8,
            color: '#111',
          }}
        >
          Before you go
        </h2>
        <p style={{ fontSize: 14, color: '#666', marginBottom: 24, lineHeight: 1.6 }}>
          Why are you cancelling? (Optional — helps us improve.)
        </p>

        <form onSubmit={handleSubmit} data-testid="cancel-survey-form">
          <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
            <legend className="sr-only">Cancellation reason</legend>
            {REASONS.map(({ value, label }) => (
              <label
                key={value}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginBottom: 10,
                  cursor: 'pointer',
                  fontSize: 14,
                  color: '#333',
                }}
              >
                <input
                  type="radio"
                  name="cancel-reason"
                  data-testid={`cancel-reason-${value}`}
                  value={value}
                  checked={reason === value}
                  onChange={() => setReason(value)}
                  style={{ accentColor: '#111' }}
                />
                {label}
              </label>
            ))}
          </fieldset>

          {reason === 'other' && (
            <textarea
              data-testid="cancel-reason-detail"
              value={reasonDetail}
              onChange={e => setReasonDetail(e.target.value)}
              placeholder="Tell us more..."
              rows={3}
              style={{
                width: '100%',
                padding: '8px 12px',
                fontSize: 13,
                border: '1px solid #ddd',
                borderRadius: 4,
                resize: 'vertical',
                marginTop: 4,
                marginBottom: 8,
                boxSizing: 'border-box',
                fontFamily: 'inherit',
              }}
            />
          )}

          {error && (
            <p style={{ fontSize: 13, color: '#c0392b', marginBottom: 12 }}>{error}</p>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
            <button
              type="submit"
              data-testid="cancel-survey-submit-btn"
              disabled={!reason || submitting}
              style={{
                padding: '10px 20px',
                background: !reason || submitting ? '#ccc' : '#111',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                fontSize: 13,
                cursor: !reason || submitting ? 'not-allowed' : 'pointer',
              }}
            >
              {submitting ? 'Submitting…' : 'Continue to cancel →'}
            </button>
            <button
              type="button"
              data-testid="cancel-survey-skip-btn"
              onClick={handleSkip}
              style={{
                padding: '10px 20px',
                background: 'none',
                color: '#888',
                border: '1px solid #ddd',
                borderRadius: 4,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Skip
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
