async function request(path, params = {}) {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export const api = {
  overview: (network) => request('/api/network/overview', { network }),
  ledgerVolume: (network, start, end) => request('/api/ledgers/volume', { network, start, end }),
  opsBreakdown: (network, start, end) => request('/api/payments/breakdown', { network, start, end }),
  account: (network, id) => request(`/api/accounts/${id}`, { network }),
  assetSearch: (network, code) => request('/api/assets/search', { network, code }),
  topAssets: (network) => request('/api/assets/top', { network }),
  assetDetails: (network, assets, window) => request('/api/assets/details', { network, assets, window }),
  priceHistory: (network, code, issuer, start, end, resolution) =>
    request('/api/assets/price-history', { network, code, issuer, start, end, resolution }),
  recentTrades: (network, code, issuer) => request('/api/trades/recent', { network, code, issuer }),
  contractActivity: (network, id, start, end) => request(`/api/contracts/${id}/activity`, { network, start, end }),
  contractsAllTime: (network) => request('/api/contracts/all-time', { network }),
  contractsProtocolTrend: (network) => request('/api/contracts/protocol-trend', { network }),
  contractsNetworkTradingActivity: (network) => request('/api/contracts/network-trading-activity', { network }),
  protocolsRanking: (network) => request('/api/protocols/ranking', { network }),
  accountGrowthTrend: (network) => request('/api/growth/account-trend', { network }),
  trustlineGrowthTrend: (network) => request('/api/growth/trustline-trend', { network }),
};
