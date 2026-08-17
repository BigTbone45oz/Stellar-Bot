import { STELLAR_EXPERT_URL } from './config.js';
import { fetchJsonOrNull } from './fetchWithTimeout.js';

// USD price for one asset, via StellarExpert's asset-detail endpoint (`price` field
// confirmed to be USD, not XLM — see assets.js). Best-effort: returns null on any
// failure rather than blocking the caller on a third-party price lookup.
export async function fetchAssetUsdPrice(expertNetwork, code, issuer) {
  const assetId = code === 'XLM' ? 'XLM' : `${code}-${issuer}`;
  const data = await fetchJsonOrNull(`${STELLAR_EXPERT_URL}/explorer/${expertNetwork}/asset/${assetId}`, {
    headers: { Accept: 'application/json' },
  });
  return typeof data?.price === 'number' ? data.price : null;
}
