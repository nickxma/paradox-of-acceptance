import { useQuery } from '@tanstack/react-query';
import { createPublicClient, http } from 'viem';
import { ACCEPTANCE_PASS_ABI } from '../lib/contract.js';
import { CONTRACT_ADDRESS, targetChain, MEMBERSHIP_TOKEN_ID, API_BASE_URL } from '../lib/config.js';

const publicClient = createPublicClient({
  chain: targetChain,
  transport: http(),
});

async function checkOnChainMembership(address) {
  if (!address || !CONTRACT_ADDRESS) return false;

  const result = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: ACCEPTANCE_PASS_ABI,
    functionName: 'isMember',
    args: [address],
  });

  return result;
}

async function checkStripeSubscription(address) {
  if (!address || !API_BASE_URL) return false;

  try {
    const res = await fetch(
      `${API_BASE_URL}/api/stripe/subscription?wallet=${encodeURIComponent(address)}`
    );
    if (!res.ok) return false;
    const data = await res.json();
    return data.isSubscriber === true;
  } catch {
    return false;
  }
}

async function checkMembership(address) {
  const [onChain, stripe] = await Promise.all([
    checkOnChainMembership(address),
    checkStripeSubscription(address),
  ]);
  return { isMember: onChain || stripe, isStripeSubscriber: stripe };
}

export function useMembershipStatus(address) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['membership', address],
    queryFn: () => checkMembership(address),
    enabled: !!address && (!!CONTRACT_ADDRESS || !!API_BASE_URL),
    staleTime: 10_000,
  });

  return {
    isMember: data?.isMember ?? false,
    isStripeSubscriber: data?.isStripeSubscriber ?? false,
    isLoading: isLoading && !!address,
    refetch,
  };
}

export async function getTotalMinted() {
  if (!CONTRACT_ADDRESS) return 0n;

  return publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: ACCEPTANCE_PASS_ABI,
    functionName: 'totalMinted',
  });
}
