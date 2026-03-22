import React, { useState, useCallback } from 'react';
import { useWallets } from '@privy-io/react-auth';
import { createWalletClient, custom, encodeFunctionData } from 'viem';
import { ACCEPTANCE_PASS_ABI } from '../lib/contract.js';
import { CONTRACT_ADDRESS, targetChain, API_BASE_URL } from '../lib/config.js';
import { useMembershipStatus } from '../hooks/useMembershipStatus.js';

export default function MintFlow({ walletAddress }) {
  const { wallets } = useWallets();
  const { refetch } = useMembershipStatus(walletAddress);
  const [minting, setMinting] = useState(false);
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [txHash, setTxHash] = useState(null);

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

  const handleStripeCheckout = useCallback(async () => {
    if (!walletAddress || !API_BASE_URL) return;

    setSubscribing(true);
    setError(null);

    try {
      const res = await fetch(`${API_BASE_URL}/api/stripe/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress }),
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
        </div>
      )}

      {error && <p className="status-line error" style={{ textAlign: 'center' }}>{error}</p>}
    </>
  );
}
