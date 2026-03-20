# Acceptance Pass — Deployment Guide

## Architecture

- **Contract**: ERC-1155 on Base (soulbound, one per address)
- **Frontend**: Vite + React app at `/pass/` with Privy wallet integration
- **Chain**: Base Sepolia (testnet) → Base (production)

## Testnet Deployment (Current)

### Contract
- **Address**: `0x9691107411AFB05b81CfDE537Efc4a00b9b1bB69`
- **Chain**: Base Sepolia (chain ID 84532)
- **Owner**: `0x60dFFC7aB012e988A8aC8048bA29f16C6CF067b7`
- **Explorer**: https://sepolia.basescan.org/address/0x9691107411AFB05b81CfDE537Efc4a00b9b1bB69

### Frontend
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

### `pass/.env`
```
VITE_PRIVY_APP_ID=cmmyfvex101cy0clawnzxpur2
VITE_CONTRACT_ADDRESS=0x9691107411AFB05b81CfDE537Efc4a00b9b1bB69
VITE_CHAIN_ENV=testnet
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

Then update `VITE_CONTRACT_ADDRESS` in `pass/.env` and `VITE_CHAIN_ENV=production`.

## Build Frontend

```bash
cd pass
npm install
npm run build
```

Output is in `pass/dist/`. Deploy to GitHub Pages alongside the rest of the site.

## Dev Server

```bash
cd pass
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

- [ ] Deploy contract to Base mainnet
- [ ] Update `VITE_CONTRACT_ADDRESS` and `VITE_CHAIN_ENV=production` in `pass/.env`
- [ ] Configure Privy paymaster policy for gas sponsorship on Base mainnet
- [ ] Rebuild frontend (`npm run build` in `pass/`)
- [ ] Deploy `pass/dist/` to GitHub Pages
- [ ] Verify contract on Basescan
- [ ] Test end-to-end: connect → mint → members area
- [ ] Verify metadata renders on Basescan/OpenSea
