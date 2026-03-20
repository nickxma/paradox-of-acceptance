import { useQuery } from '@tanstack/react-query';
import { createPublicClient, http } from 'viem';
import { ACCEPTANCE_PASS_ABI } from '../lib/contract.js';
import { CONTRACT_ADDRESS, targetChain, MEMBERSHIP_TOKEN_ID } from '../lib/config.js';

const publicClient = createPublicClient({
  chain: targetChain,
  transport: http(),
});

async function checkMembership(address) {
  if (!address || !CONTRACT_ADDRESS) return false;

  const result = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: ACCEPTANCE_PASS_ABI,
    functionName: 'isMember',
    args: [address],
  });

  return result;
}

export function useMembershipStatus(address) {
  const { data: isMember, isLoading, refetch } = useQuery({
    queryKey: ['membership', address],
    queryFn: () => checkMembership(address),
    enabled: !!address && !!CONTRACT_ADDRESS,
    staleTime: 10_000,
  });

  return {
    isMember: isMember ?? false,
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
