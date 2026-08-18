import { httpError } from './httpError.js';

// Cache keys downstream (ledgerSeq, ledgerVolume, opsBreakdown, contractActivity,
// priceHistory) are built from start/end, so flooring to the minute here means
// re-clicking the same date-range preset actually hits the cache instead of
// missing on millisecond-precision timestamps from a fresh `new Date()` each
// click. Start and end are floored independently, so the range width isn't
// guaranteed to only shrink — it can come out up to ~1 minute wider than
// requested. Immaterial at this app's day-level chart granularity.
const CACHE_GRANULARITY_MS = 60_000;

function floorToGranularity(ms) {
  return Math.floor(ms / CACHE_GRANULARITY_MS) * CACHE_GRANULARITY_MS;
}

// The client restricts date-range presets per-view, but that's client-side
// only — nothing stops a direct API call from requesting an arbitrarily wide
// range. For ledger-sequence-chunked routes, maxRecords bounds what's
// *returned* but not how many low-yield chunks get walked *to reach* that cap
// on a range with a long sparse prefix. This shared ceiling bounds that.
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000; // ~1 year

/**
 * Parses and validates start/end query params. Throws a request-shaped error
 * (.status = 400) on anything unparseable, rather than letting NaN silently
 * propagate into ledger-time binary search and cache TTL logic.
 */
export function parseDateRange(query) {
  const { start, end } = query;
  if (!start || !end) {
    throw httpError(400, 'start and end query params (ISO dates) are required');
  }
  const rawStartMs = new Date(start).getTime();
  const rawEndMs = new Date(end).getTime();
  if (!Number.isFinite(rawStartMs) || !Number.isFinite(rawEndMs)) {
    throw httpError(400, 'start and end must be valid dates');
  }
  if (rawStartMs > rawEndMs) {
    throw httpError(400, 'start must be before end');
  }
  if (rawEndMs - rawStartMs > MAX_RANGE_MS) {
    throw httpError(400, `Date range too wide — max is ${Math.floor(MAX_RANGE_MS / 86_400_000)} days`);
  }

  const startMs = floorToGranularity(rawStartMs);
  const endMs = floorToGranularity(rawEndMs);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    startMs,
    endMs,
  };
}
