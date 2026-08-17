import { STELLAR_EXPERT_URL } from './config.js';

// USD price for one asset, via StellarExpert's asset-detail endpoint (`price` field
// confirmed to be USD, not XLM — see assets.js). Best-effort: returns null on any
// failure rather than blocking the caller on a third-party price lookup.
export async function fetchAssetUsdPrice(expertNetwork, code, issuer) {
  const assetId = code === 'XLM' ? 'XLM' : `${code}-${issuer}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${STELLAR_EXPERT_URL}/explorer/${expertNetwork}/asset/${assetId}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.price === 'number' ? data.price : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
