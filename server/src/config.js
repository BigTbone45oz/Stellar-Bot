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

// Third-party best-effort optimization with a built-in fallback — see ledgerTime.js.
export const STELLAR_EXPERT_URL = process.env.STELLAR_EXPERT_URL || 'https://api.stellar.expert';

// Both optional: routes degrade to "unavailable" rather than erroring when unset.
export const DUNE_API_KEY = process.env.DUNE_API_KEY || null;
export const DUNE_QUERY_ID = process.env.DUNE_QUERY_ID || null;
export const DUNE_SOROSWAP_TREND_QUERY_ID = process.env.DUNE_SOROSWAP_TREND_QUERY_ID || null;
export const DUNE_SOROSWAP_FUNCTIONS_QUERY_ID = process.env.DUNE_SOROSWAP_FUNCTIONS_QUERY_ID || null;
export const DUNE_NETWORK_TRADES_QUERY_ID = process.env.DUNE_NETWORK_TRADES_QUERY_ID || null;
export const DUNE_ACCOUNT_GROWTH_QUERY_ID = process.env.DUNE_ACCOUNT_GROWTH_QUERY_ID || null;
export const DUNE_TRUSTLINE_GROWTH_QUERY_ID = process.env.DUNE_TRUSTLINE_GROWTH_QUERY_ID || null;
export const DUNE_PROTOCOL_FUNCTIONS_QUERY_ID = process.env.DUNE_PROTOCOL_FUNCTIONS_QUERY_ID || null;

export function resolveNetwork(param) {
  const key = param === 'testnet' ? 'testnet' : 'pubnet';
  return { key, ...NETWORKS[key] };
}

export const PORT = process.env.PORT || 8787;

// Trailing-window size for chart-bound trend series (growth.js, protocols.js).
export const TREND_DAYS = 180;
