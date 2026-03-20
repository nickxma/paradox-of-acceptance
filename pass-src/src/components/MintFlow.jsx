import React, { useState, useCallback } from 'react';
import { useWallets } from '@privy-io/react-auth';
import { createWalletClient, custom, encodeFunctionData } from 'viem';
import { ACCEPTANCE_PASS_ABI } from '../lib/contract.js';
import { CONTRACT_ADDRESS, targetChain } from '../lib/config.js';
import { useMembershipStatus } from '../hooks/useMembershipStatus.js';

export default function MintFlow({ walletAddress }) {
  const { wallets } = useWallets();
  const { refetch } = useMembershipStatus(walletAddress);
  const [minting, setMinting] = useState(false);
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
        <h1 className="pass-headline">Mint your Acceptance Pass</h1>
        <p className="pass-subtitle">
          Free. Non-transferable. One per person.
          Your membership credential for the Paradox of Acceptance.
        </p>
      </div>

      <div className="pass-card">
        <div className="pass-card-label">What this gives you</div>
        <p className="pass-card-text">
          Access to members-only practices, early essays, and deeper material.
          No cost, no speculation — just a way to mark your participation.
        </p>
        <p className="pass-card-text" style={{ fontSize: 13, color: '#999' }}>
          Minted on Base (Ethereum L2). Gas is sponsored — you don't need ETH.
        </p>
      </div>

      <div style={{ textAlign: 'center' }}>
        <button
          className="btn-primary"
          onClick={handleMint}
          disabled={minting || !walletAddress}
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

        {error && <p className="status-line error">{error}</p>}

        <p style={{ fontSize: 13, color: '#BBB', marginTop: 16 }}>
          Connected as {walletAddress?.slice(0, 6)}...{walletAddress?.slice(-4)}
        </p>
      </div>
    </>
  );
}
