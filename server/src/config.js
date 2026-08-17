import 'dotenv/config';

export const NETWORKS = {
  pubnet: {
    label: 'Public Network',
    horizon: process.env.HORIZON_PUBNET_URL || 'https://horizon.stellar.org',
    sorobanRpc: process.env.SOROBAN_PUBNET_RPC || 'https://mainnet.sorobanrpc.com',
  },
  testnet: {
    label: 'Testnet',
    horizon: process.env.HORIZON_TESTNET_URL || 'https://horizon-testnet.stellar.org',
    sorobanRpc: process.env.SOROBAN_TESTNET_RPC || 'https://soroban-testnet.stellar.org',
  },
};

// Third-party (not Horizon/Soroban RPC), used as a best-effort optimization with a
// built-in fallback — see ledgerTime.js. Configurable for the same reason the URLs
// above are: testing against a mock, or if the upstream URL ever changes.
export const STELLAR_EXPERT_URL = process.env.STELLAR_EXPERT_URL || 'https://api.stellar.expert';

// Powers the all-time Soroban asset-movement stat on the Smart Contracts page —
// see contracts.js's /all-time route and duneClient.js. Both optional: the route
// degrades to "unavailable" rather than erroring when either is unset.
export const DUNE_API_KEY = process.env.DUNE_API_KEY || null;
export const DUNE_QUERY_ID = process.env.DUNE_QUERY_ID || null;
export const DUNE_SOROSWAP_TREND_QUERY_ID = process.env.DUNE_SOROSWAP_TREND_QUERY_ID || null;
export const DUNE_SOROSWAP_FUNCTIONS_QUERY_ID = process.env.DUNE_SOROSWAP_FUNCTIONS_QUERY_ID || null;
export const DUNE_NETWORK_TRADES_QUERY_ID = process.env.DUNE_NETWORK_TRADES_QUERY_ID || null;

export function resolveNetwork(param) {
  const key = param === 'testnet' ? 'testnet' : 'pubnet';
  return { key, ...NETWORKS[key] };
}

export const PORT = process.env.PORT || 8787;
