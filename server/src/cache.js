// Minimal in-memory TTL cache. Good enough for a single-user local dashboard —
// swap for Redis if this ever needs to run multi-instance.

const store = new Map();

export const TTL = {
  LIVE: 30 * 1000,          // network overview, latest ledger — changes constantly
  RECENT: 60 * 1000,        // "today" buckets in a date range that's still moving
  HOURLY: 60 * 60 * 1000,   // third-party aggregates that only refresh every so often (e.g. DeFiLlama)
  FINALIZED: 12 * 60 * 60 * 1000, // date ranges entirely in the past — data can't change
};

export function cacheGet(key) {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return undefined;
  }
  return entry.value;
}

export function cacheSet(key, value, ttlMs) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/**
 * Picks TTL.FINALIZED if the range's end is safely in the past, otherwise TTL.RECENT.
 * This is the "immutable history vs. live data" rule from the plan.
 */
export function ttlForRange(endTimeMs) {
  const bufferMs = 5 * 60 * 1000; // 5 min safety margin behind "now"
  return endTimeMs < Date.now() - bufferMs ? TTL.FINALIZED : TTL.RECENT;
}

export async function cached(key, ttlMs, fn) {
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const value = await fn();
  cacheSet(key, value, ttlMs);
  return value;
}

// Store only checks/evicts on read, so an entry that's never read again would
// otherwise sit in memory forever. Sweep periodically rather than letting a
// long-running dev session grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    if (now > entry.expiresAt) store.delete(key);
  }
}, 10 * 60 * 1000).unref();
