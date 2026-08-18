import { STELLAR_EXPERT_URL } from './config.js';
import { fetchJsonOrNull } from './fetchWithTimeout.js';
import { cached, TTL } from './cache.js';
import { runWorkerPool } from './workerPool.js';

// StellarExpert's asset-detail `price` field is USD, not XLM. Best-effort: returns
// null on any failure rather than blocking the caller on a third-party lookup.
export async function fetchAssetUsdPrice(expertNetwork, code, issuer) {
  const assetId = code === 'XLM' ? 'XLM' : `${code}-${issuer}`;
  const data = await fetchJsonOrNull(`${STELLAR_EXPERT_URL}/explorer/${expertNetwork}/asset/${assetId}`, {
    headers: { Accept: 'application/json' },
  });
  return typeof data?.price === 'number' ? data.price : null;
}

// USD-prices a list of { code, issuer, ...amountField } entries in place, using
// a bounded worker pool (independent per-entry lookups, no reason to serialize).
// `amountField` is configurable since callers key their amount differently.
export async function priceMovementList(movementList, expertNetwork, netKey, amountField = 'total') {
  if (!expertNetwork) {
    for (const entry of movementList) {
      entry.priceUsd = null;
      entry.totalUsd = null;
    }
    return;
  }
  await runWorkerPool(movementList, 6, async (entry) => {
    entry.priceUsd = await cached(
      `assetPriceUsd:${netKey}:${entry.code}:${entry.issuer || 'native'}`,
      TTL.RECENT,
      () => fetchAssetUsdPrice(expertNetwork, entry.code, entry.issuer)
    ).catch(() => null);
    entry.totalUsd = entry.priceUsd !== null ? entry[amountField] * entry.priceUsd : null;
  });
}

// Sorts by USD value when known; entries with a failed price lookup fall back
// to a raw-amount field and sort below priced ones, rather than being dropped.
export function sortMovementList(movementList, fallbackField = 'changeCount') {
  movementList.sort((a, b) => {
    if (a.totalUsd !== null && b.totalUsd !== null) return b.totalUsd - a.totalUsd;
    if (a.totalUsd !== null) return -1;
    if (b.totalUsd !== null) return 1;
    return b[fallbackField] - a[fallbackField];
  });
}
