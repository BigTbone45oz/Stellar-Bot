// Bounded-concurrency worker pool for independent per-item async work (no
// reason to serialize). Each worker claims the next unclaimed index from a
// shared counter until items run out — same shape previously hand-duplicated
// across assetPricing.js, assets.js (x2), and contracts.js.
export async function runWorkerPool(items, concurrency, fn) {
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) || 1 }, worker));
}
