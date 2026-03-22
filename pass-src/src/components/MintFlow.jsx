import React, { useState, useCallback } from 'react';
import { useWalletsContext } from '../lib/auth-context.jsx';
import { createWalletClient, custom, encodeFunctionData } from 'viem';
import { ACCEPTANCE_PASS_ABI } from '../lib/contract.js';
import { CONTRACT_ADDRESS, targetChain, API_BASE_URL } from '../lib/config.js';
import { useMembershipStatus } from '../hooks/useMembershipStatus.js';

export default function MintFlow({ walletAddress }) {
  const { wallets } = useWalletsContext();
  const { refetch } = useMembershipStatus(walletAddress);
  const [minting, setMinting] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [txHash, setTxHash] = useState(null);

  // Promo code state
  const [promoOpen, setPromoOpen] = useState(false);
  const [promoInput, setPromoInput] = useState('');
  const [promoValidating, setPromoValidating] = useState(false);
  const [promoResult, setPromoResult] = useState(null); // { valid, promotionCodeId, percentOff, amountOff, currency, name } | null
  const [promoError, setPromoError] = useState(null);

  const handleMint = useCallback(async () => {
    if (!wallets?.[0] || !CONTRACT_ADDRESS) return;

    setMinting(true);
    setError(null);

    try {
      const wallet = wallets[0];
      const provider = await wallet.getEthereumProvider();

      // Switch to target chain if needed
      await wallet.switchChain(targetChain.id);

      const walletClient = createWalletClient({
        chain: targetChain,
        transport: custom(provider),
        account: wallet.address,
      });

      const hash = await walletClient.sendTransaction({
        to: CONTRACT_ADDRESS,
        data: encodeFunctionData({
          abi: ACCEPTANCE_PASS_ABI,
          functionName: 'mint',
        }),
      });

      setTxHash(hash);
      setSuccess(true);

      // Refetch membership status after a brief delay for indexing
      setTimeout(() => refetch(), 3000);
    } catch (err) {
      console.error('Mint error:', err);
      if (err.message?.includes('AlreadyMinted')) {
        setError('You already have an Acceptance Pass.');
        setTimeout(() => refetch(), 1000);
      } else if (err.message?.includes('user rejected') || err.message?.includes('User rejected')) {
        setError('Transaction cancelled.');
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setMinting(false);
    }
  }, [wallets, refetch]);

  const handleValidatePromo = useCallback(async () => {
    if (!promoInput.trim() || !API_BASE_URL) return;

    setPromoValidating(true);
    setPromoError(null);
    setPromoResult(null);

    try {
      const res = await fetch(`${API_BASE_URL}/api/stripe/validate-promo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: promoInput.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPromoError('Could not validate code. Please try again.');
      } else if (!data.valid) {
        setPromoError('Invalid or expired promo code.');
      } else {
        setPromoResult(data);
      }
    } catch {
      setPromoError('Could not validate code. Please try again.');
    } finally {
      setPromoValidating(false);
    }
  }, [promoInput]);

  const handleStripeCheckout = useCallback(async () => {
    if (!walletAddress || !API_BASE_URL) return;

    setSubscribing(true);
    setError(null);

    try {
      const body = { walletAddress };
      if (promoResult?.valid && promoResult?.promotionCodeId) {
        body.promoCode = promoInput.trim();
      }
      const res = await fetch(`${API_BASE_URL}/api/stripe/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to start checkout');
      }

      const { url } = await res.json();
      if (url) {
        window.location.href = url;
      } else {
        throw new Error('No checkout URL returned');
      }
    } catch (err) {
      console.error('Stripe checkout error:', err);
      setError('Could not start checkout. Please try again.');
      setSubscribing(false);
    }
  }, [walletAddress]);

  if (success) {
    return (
      <>
        <div className="pass-hero">
          <h1 className="pass-headline">Welcome.</h1>
          <p className="pass-subtitle">
            Your Acceptance Pass has been minted. You're now a member.
          </p>
        </div>

        <div className="pass-card">
          <div className="pass-card-label">Your pass</div>
          <p className="pass-card-text">
            A non-transferable membership credential, held in your wallet on Base.
            Refresh the page to access the members area.
          </p>
          {txHash && (
            <p style={{ fontSize: 13, color: '#999', marginTop: 12 }}>
              Transaction:{' '}
              <a
                href={`${targetChain.blockExplorers.default.url}/tx/${txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#666', textDecoration: 'underline' }}
              >
                {txHash.slice(0, 10)}...{txHash.slice(-8)}
              </a>
            </p>
          )}
        </div>

        <div style={{ textAlign: 'center' }}>
          <button className="btn-primary" onClick={() => window.location.reload()}>
            Enter members area
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="pass-hero">
        <h1 className="pass-headline">Unlock the members area</h1>
        <p className="pass-subtitle">
          Access members-only practices, early essays, and deeper material.
          Choose how you'd like to join.
        </p>
      </div>

      {/* Option 1: Free on-chain pass */}
      <div className="pass-card">
        <div className="pass-card-label">Free · On-chain</div>
        <p className="pass-card-text">
          Mint an Acceptance Pass — a non-transferable membership credential on Base (Ethereum L2).
          Free to mint. Gas is sponsored — you don't need ETH.
        </p>
        <div style={{ textAlign: 'center', marginTop: 8 }}>
          <button
            className="btn-primary"
            onClick={handleMint}
            disabled={minting || !walletAddress || !CONTRACT_ADDRESS}
          >
            {minting ? (
              <>
                <span className="spinner" />
                Minting...
              </>
            ) : (
              'Mint Acceptance Pass'
            )}
          </button>
          <p style={{ fontSize: 13, color: '#BBB', marginTop: 12 }}>
            Connected as {walletAddress?.slice(0, 6)}...{walletAddress?.slice(-4)}
          </p>
        </div>
      </div>

      {/* Divider */}
      <div style={{ textAlign: 'center', margin: '4px 0 8px', fontSize: 13, color: '#CCC' }}>or</div>

      {/* Option 2: Stripe subscription */}
      {API_BASE_URL && (
        <div className="pass-card">
          <div className="pass-card-label">Subscribe · Card</div>
          <p className="pass-card-text">
            No crypto required. Subscribe with a credit or debit card for monthly access.
            Cancel anytime.
          </p>
          <div style={{ textAlign: 'center', marginTop: 8 }}>
            <button
              data-testid="subscribe-with-card-btn"
              className="btn-secondary"
              onClick={handleStripeCheckout}
              disabled={subscribing || !walletAddress}
              style={{ fontSize: 14, padding: '12px 28px' }}
            >
              {subscribing ? (
                <>
                  <span className="spinner" style={{ borderColor: '#999', borderTopColor: 'transparent' }} />
                  Redirecting...
                </>
              ) : (
                'Subscribe with card →'
              )}
            </button>
          </div>

          {/* Promo code field */}
          <div style={{ marginTop: 16 }}>
            <button
              onClick={() => {
                setPromoOpen(o => !o);
                setPromoError(null);
                setPromoResult(null);
                setPromoInput('');
              }}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 13,
                color: '#888',
                textDecoration: 'underline',
                padding: 0,
              }}
            >
              {promoOpen ? 'Hide promo code' : 'Have a promo code?'}
            </button>

            {promoOpen && (
              <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  data-testid="promo-code-input"
                  type="text"
                  value={promoInput}
                  onChange={e => {
                    setPromoInput(e.target.value);
                    setPromoResult(null);
                    setPromoError(null);
                  }}
                  onKeyDown={e => { if (e.key === 'Enter') handleValidatePromo(); }}
                  placeholder="Enter code"
                  disabled={promoValidating || !!promoResult}
                  style={{
                    flex: '1 1 120px',
                    padding: '8px 12px',
                    fontSize: 13,
                    border: '1px solid #ddd',
                    borderRadius: 4,
                    outline: 'none',
                    background: '#faf8f4',
                    color: '#2c2c2c',
                  }}
                />
                {!promoResult ? (
                  <button
                    data-testid="promo-apply-btn"
                    onClick={handleValidatePromo}
                    disabled={promoValidating || !promoInput.trim()}
                    style={{
                      padding: '8px 16px',
                      fontSize: 13,
                      background: '#2c2c2c',
                      color: '#fff',
                      border: 'none',
                      borderRadius: 4,
                      cursor: promoValidating || !promoInput.trim() ? 'not-allowed' : 'pointer',
                      opacity: promoValidating || !promoInput.trim() ? 0.6 : 1,
                    }}
                  >
                    {promoValidating ? 'Checking…' : 'Apply'}
                  </button>
                ) : (
                  <button
                    onClick={() => { setPromoResult(null); setPromoInput(''); }}
                    style={{
                      padding: '8px 12px',
                      fontSize: 13,
                      background: 'none',
                      color: '#888',
                      border: '1px solid #ddd',
                      borderRadius: 4,
                      cursor: 'pointer',
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
            )}

            {promoError && (
              <p data-testid="promo-error" style={{ fontSize: 12, color: '#c0392b', marginTop: 6 }}>{promoError}</p>
            )}
            {promoResult?.valid && (
              <p data-testid="promo-success" style={{ fontSize: 12, color: '#7d8c6e', marginTop: 6 }}>
                ✓ Code applied
                {promoResult.percentOff != null && ` — ${promoResult.percentOff}% off`}
                {promoResult.amountOff != null && promoResult.currency &&
                  ` — ${(promoResult.amountOff / 100).toFixed(2)} ${promoResult.currency.toUpperCase()} off`}
              </p>
            )}
          </div>
        </div>
      )}

      {error && <p className="status-line error" style={{ textAlign: 'center' }}>{error}</p>}
    </>
  );
}
