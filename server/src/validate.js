import { httpError } from './httpError.js';

// Cache keys downstream (ledgerSeq, ledgerVolume, opsBreakdown, contractActivity,
// priceHistory) are built from these values. Rounding to the nearest minute here
// means re-clicking the same date-range preset — the single most common
// interaction — actually hits the cache instead of missing on millisecond-precision
// timestamp differences from `new Date().toISOString()` being called fresh each
// time. Note this floors start AND end independently, so the resulting range's
// WIDTH isn't guaranteed to only shrink — start moves earlier (widening the range
// backward) while end also moves earlier (narrowing the forward edge), so
// depending on where each raw timestamp falls within its own minute, the floored
// range can come out up to ~1 minute wider than requested, not just narrower.
// Immaterial at the day-level granularity every chart in this app buckets at,
// same as the millisecond-level trim itself — just don't assume "floor" here
// means "monotonically shrinks."
const CACHE_GRANULARITY_MS = 60_000;

function floorToGranularity(ms) {
  return Math.floor(ms / CACHE_GRANULARITY_MS) * CACHE_GRANULARITY_MS;
}

// The client's DateRangePicker restricts presets per-view (see CLAUDE.md) so the
// UI itself never asks for more than a route can deliver without truncating —
// but that's enforcement in the client only. Nothing previously stopped a direct
// API call (or a future client bug) from requesting an arbitrarily wide range.
// For routes that page Horizon in ledger-sequence chunks (ledgers.js,
// payments.js, the contracts.js fallback), maxRecords bounds how much gets
// *returned*, but not how many low-yield chunks the worker pool has to walk
// through *to reach* that cap on a range with a long sparse prefix (e.g. one
// stretching back toward early Stellar history). One shared, generous-but-real
// ceiling here bounds that regardless of which route is called.
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000; // ~1 year

/**
 * Parses and validates start/end query params. Throws a request-shaped error
 * (with .status = 400) on anything unparseable, rather than letting NaN
 * silently propagate into ledger-time binary search and cache TTL logic —
 * that used to fail quietly instead of with a clear error.
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
