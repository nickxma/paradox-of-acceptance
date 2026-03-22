import { base, baseSepolia } from 'viem/chains';

// Use testnet by default until production deployment
const isProduction = import.meta.env.VITE_CHAIN_ENV === 'production';

export const targetChain = isProduction ? base : baseSepolia;

export const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID || '';

export const CONTRACT_ADDRESS = import.meta.env.VITE_CONTRACT_ADDRESS || '';

export const MEMBERSHIP_TOKEN_ID = 1n;

// API base URL for Stripe endpoints (Vercel serverless functions)
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';
