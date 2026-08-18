import { STELLAR_EXPERT_URL } from './config.js';
import { fetchJsonOrNull } from './fetchWithTimeout.js';
import { cached, TTL } from './cache.js';

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

// USD-prices a list of { code, issuer, ...amountField } entries in place, using
// a bounded worker pool (independent per-entry lookups, no reason to serialize).
// Shared by payments.js's contract-movement/payment-movement passes and
// contracts.js's /all-time route — those two had drifted into two separately
// hand-maintained copies (one keyed its amount field `total`, the other
// `totalAmount`) before being unified here.
export async function priceMovementList(movementList, expertNetwork, netKey, amountField = 'total') {
  if (!expertNetwork) {
    for (const entry of movementList) {
      entry.priceUsd = null;
      entry.totalUsd = null;
    }
    return;
  }
  const CONCURRENCY = 6;
  let nextIdx = 0;
  async function priceWorker() {
    while (nextIdx < movementList.length) {
      const entry = movementList[nextIdx++];
      entry.priceUsd = await cached(
        `assetPriceUsd:${netKey}:${entry.code}:${entry.issuer || 'native'}`,
        TTL.RECENT,
        () => fetchAssetUsdPrice(expertNetwork, entry.code, entry.issuer)
      ).catch(() => null);
      entry.totalUsd = entry.priceUsd !== null ? entry[amountField] * entry.priceUsd : null;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, movementList.length) || 1 }, priceWorker));
}

// Sorts a priced movement list by USD value when known (what "top assets
// moved" should mean), falling back to a raw-amount field for anything price
// lookup failed on — those still get listed, just pushed below the priced
// ones rather than dropped, so a failed price lookup can't silently hide
// real activity.
export function sortMovementList(movementList, fallbackField = 'changeCount') {
  movementList.sort((a, b) => {
    if (a.totalUsd !== null && b.totalUsd !== null) return b.totalUsd - a.totalUsd;
    if (a.totalUsd !== null) return -1;
    if (b.totalUsd !== null) return 1;
    return b[fallbackField] - a[fallbackField];
  });
}
