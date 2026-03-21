# Acceptance Pass — Deployment Guide

## Architecture

- **Contract**: ERC-1155 on Base (soulbound, one per address)
- **Frontend**: Vite + React app at `/pass/` with Privy wallet integration
- **Chain**: Base (production, chain ID 8453)

## Production Deployment (Current)

### Contract
- **Address**: `0x9691107411AFB05b81CfDE537Efc4a00b9b1bB69`
- **Chain**: Base mainnet (chain ID 8453)
- **Owner**: `0x60dFFC7aB012e988A8aC8048bA29f16C6CF067b7`
- **Explorer**: https://basescan.org/address/0x9691107411AFB05b81CfDE537Efc4a00b9b1bB69

### Testnet Contract (same address, Base Sepolia)
- **Explorer**: https://sepolia.basescan.org/address/0x9691107411AFB05b81CfDE537Efc4a00b9b1bB69

### Frontend
- **Live URL**: https://paradoxofacceptance.xyz/pass/
- **Privy App ID**: `cmmyfvex101cy0clawnzxpur2`
- **Privy Dashboard**: https://dashboard.privy.io/apps/cmmyfvex101cy0clawnzxpur2

## Environment Variables

### `contracts/.env`
```
DEPLOYER_PRIVATE_KEY=0x...
OWNER_ADDRESS=0x60dFFC7aB012e988A8aC8048bA29f16C6CF067b7
TOKEN_URI=https://paradoxofacceptance.xyz/pass/metadata/{id}.json
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
BASE_RPC_URL=https://mainnet.base.org
```

### `pass-src/.env`
```
VITE_PRIVY_APP_ID=cmmyfvex101cy0clawnzxpur2
VITE_CONTRACT_ADDRESS=0x9691107411AFB05b81CfDE537Efc4a00b9b1bB69
VITE_CHAIN_ENV=production
```

## Deploy Contract (new chain/redeploy)

```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast
```

For production (Base mainnet):
```bash
forge script script/Deploy.s.sol --rpc-url base --broadcast
```

Then update `VITE_CONTRACT_ADDRESS` in `pass-src/.env` and `VITE_CHAIN_ENV=production`.

## Build Frontend

```bash
cd pass-src
npm install
npm run build
```

Output goes to `pass/` (served by GitHub Pages at `/pass/`). Commit the built output and push to deploy.

## Dev Server

```bash
cd pass-src
npm run dev
```

## Admin Operations

### Pause minting
```bash
cast send $CONTRACT_ADDRESS "pause()" --rpc-url $RPC_URL --private-key $DEPLOYER_PRIVATE_KEY
```

### Unpause minting
```bash
cast send $CONTRACT_ADDRESS "unpause()" --rpc-url $RPC_URL --private-key $DEPLOYER_PRIVATE_KEY
```

### Update metadata URI
```bash
cast send $CONTRACT_ADDRESS "setURI(string)" "https://new-uri/{id}.json" --rpc-url $RPC_URL --private-key $DEPLOYER_PRIVATE_KEY
```

### Check membership
```bash
cast call $CONTRACT_ADDRESS "isMember(address)(bool)" $WALLET_ADDRESS --rpc-url $RPC_URL
```

### Get total minted
```bash
cast call $CONTRACT_ADDRESS "totalMinted()(uint256)" --rpc-url $RPC_URL
```

## Production Checklist

- [x] Deploy contract to Base mainnet
- [x] Update `VITE_CONTRACT_ADDRESS` and `VITE_CHAIN_ENV=production` in `pass-src/.env`
- [x] Configure Privy gas sponsorship (see below)
- [x] Rebuild frontend (`npm run build` in `pass-src/`)
- [x] Commit built `pass/` output and push to deploy
- [x] Verify contract on Sourcify (exact match)
- [x] Test mint on mainnet (tx: `0xd61261ba99e4c90cf8360c8708074c28bb202553c9ab84609a667e26f5211b4a`)
- [x] Verify metadata renders (JSON + SVG load correctly)
- [x] Test web UI end-to-end: connect wallet → mint → members area (nick0xma.eth minted Pass #2)

## Gas Sponsorship Setup (Privy Dashboard)

Gas sponsorship for embedded wallets is configured in the Privy dashboard, not in code. The current frontend code already supports it transparently — Privy's embedded wallet provider routes through a paymaster when enabled.

Steps:
1. Go to [Privy Dashboard](https://dashboard.privy.io/apps/cmmyfvex101cy0clawnzxpur2)
2. Navigate to **Embedded Wallets** → **Gas Sponsorship** (or **Smart Wallets**)
3. Enable gas sponsorship for **Base** (chain ID 8453)
4. Set a spending policy (e.g., max gas per user per day)
5. Save

Once enabled, embedded wallet users can mint without holding ETH. External wallet users (Rainbow, MetaMask) pay their own gas (~$0.001 per mint on Base — negligible).

Note: Privy may have a free gas sponsorship tier for Base through their Coinbase partnership. Check the dashboard for available options.
