import { cached, ttlForRange, TTL } from './cache.js';
import { STELLAR_EXPERT_URL } from './config.js';

// StellarExpert's network naming differs from ours ('pubnet' here vs their 'public').
// Exported so other routes hitting the StellarExpert API (e.g. assets.js's /top) reuse
// this instead of redefining it.
export const STELLAR_EXPERT_NETWORK = { pubnet: 'public', testnet: 'testnet' };

/**
 * Horizon has no start/end time filter for ledgers/transactions/operations —
 * only cursor-based paging. StellarExpert (api.stellar.expert) offers a free,
 * no-auth, CORS-enabled endpoint that resolves a timestamp to a ledger sequence
 * directly — one HTTP call instead of our own binary search's ~30 sequential
 * Horizon requests worst-case. We try that first and fall back to the binary
 * search (against our own Horizon instance, not a third party) if StellarExpert
 * is unreachable, rate-limited, or the network isn't one it supports.
 *
 * Note on semantics: StellarExpert resolves to the ledger closing *at or before*
 * the timestamp (floor); our binary search resolves to the ledger closing *at or
 * after* it (ceiling/lower_bound). They can differ by one ledger (~5s) at a
 * boundary — immaterial at the day-level bucketing this app charts at, but worth
 * knowing if this function is ever reused somewhere that needs ledger-exact
 * precision.
 *
 * Results are cached indefinitely once the target timestamp is safely in the
 * past — a given (network, timestamp) pair always resolves to the same ledger.
 */
export async function ledgerSequenceForTimestamp(horizon, networkKey, targetIso) {
  const targetMs = new Date(targetIso).getTime();
  const cacheKey = `ledgerSeq:${networkKey}:${targetIso}`;

  return cached(cacheKey, ttlForRange(targetMs), async () => {
    const viaExpert = await resolveViaStellarExpert(networkKey, targetMs);
    if (viaExpert !== null) return viaExpert;
    return resolveViaBinarySearch(horizon, targetMs);
  });
}

async function resolveViaStellarExpert(networkKey, targetMs) {
  const network = STELLAR_EXPERT_NETWORK[networkKey];
  if (!network) return null; // unsupported network name — fall back silently

  const timestampSec = Math.floor(targetMs / 1000);
  const url = `${STELLAR_EXPERT_URL}/explorer/${network}/ledger/sequence-from-timestamp?timestamp=${timestampSec}`;
  const controller = new AbortController();
  // Short timeout: this is a "try fast, fall back otherwise" path, not the
  // primary source of truth, so it shouldn't hold up the request for long.
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) return null; // 404 (out of range) or 429 (rate limited) — fall back
    const data = await res.json();
    return Number.isFinite(data.sequence) ? data.sequence : null;
  } catch {
    return null; // network error, timeout, malformed response — fall back
  } finally {
    clearTimeout(timer);
  }
}

async function resolveViaBinarySearch(horizon, targetMs) {
  const root = await horizon.get('/');
  let lo = await earliestAvailableLedger(horizon);
  let hi = root.history_latest_ledger;

  // Guard rails: if the target is before the earliest retained ledger or after
  // latest, clamp rather than binary-searching into 404s. The latest ledger's
  // close time is already in `root` — no need for a separate request for it.
  const latest = new Date(root.history_latest_ledger_closed_at).getTime();
  if (targetMs >= latest) return hi;

  const first = await getLedgerClosedAt(horizon, lo);
  if (targetMs <= first) return lo;

  // Standard binary search, ~30 requests worst case for the whole pubnet history.
  // Only reached when StellarExpert is unavailable — see ledgerSequenceForTimestamp.
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const midTime = await getLedgerClosedAt(horizon, mid);
    if (midTime < targetMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

async function getLedgerClosedAt(horizon, sequence) {
  const cacheKey = `ledgerClosedAt:${horizon.baseUrl}:${sequence}`;
  return cached(cacheKey, TTL.FINALIZED, async () => {
    const ledger = await horizon.get(`/ledgers/${sequence}`);
    return new Date(ledger.closed_at).getTime();
  });
}

/**
 * Not every Horizon instance retains full history from ledger 1 — some public
 * nodes prune older ledgers. Rather than assuming ledger 2 always exists (which
 * threw a 404 on any Horizon with partial retention), ask Horizon what its
 * earliest ledger actually is via the oldest page of /ledgers.
 */
async function earliestAvailableLedger(horizon) {
  const cacheKey = `earliestLedger:${horizon.baseUrl}`;
  return cached(cacheKey, TTL.FINALIZED, async () => {
    // No try/catch here on purpose: a real failure (timeout, 5xx, network error)
    // on this basic, always-answerable query is a genuine upstream problem, not
    // evidence ledger 2 doesn't exist — swallowing it and returning 2 unconditionally
    // would reintroduce the exact "assume ledger 2 exists" bug this function was
    // written to fix, just one layer removed (a transient failure here would still
    // end up calling getLedgerClosedAt(horizon, 2), 404ing on any instance that's
    // actually pruned it). Let it propagate as the normal, already-handled
    // timeout/HorizonError instead. The `|| 2` below is only a defensive default for
    // a genuinely empty (but successful) response, not error handling.
    const page = await horizon.get('/ledgers', { order: 'asc', limit: 1 });
    return page._embedded.records[0]?.sequence || 2;
  });
}
