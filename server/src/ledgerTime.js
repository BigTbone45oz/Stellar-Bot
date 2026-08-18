import { cached, ttlForRange, TTL } from './cache.js';
import { STELLAR_EXPERT_URL } from './config.js';
import { fetchJsonOrNull } from './fetchWithTimeout.js';

// StellarExpert's network naming differs from ours ('pubnet' here vs their 'public').
// Exported so other routes hitting the StellarExpert API (e.g. assets.js's /top) reuse
// this instead of redefining it.
export const STELLAR_EXPERT_NETWORK = { pubnet: 'public', testnet: 'testnet' };

/**
 * Horizon has no start/end time filter for ledgers/transactions/operations —
 * only cursor-based paging. StellarExpert (api.stellar.expert) offers a free,
 * no-auth, CORS-enabled endpoint that resolves a timestamp to a ledger sequence
 * directly — one HTTP call instead of a binary search's ~30 sequential Horizon
 * requests worst-case. Tried first, falling back to the binary search (against
 * our own Horizon instance) if StellarExpert is unreachable, rate-limited, or
 * the network isn't one it supports.
 *
 * Semantics differ slightly: StellarExpert resolves to the ledger closing *at
 * or before* the timestamp (floor); the binary search resolves *at or after*
 * (ceiling/lower_bound). Can differ by one ledger (~5s) at a boundary —
 * immaterial at this app's day-level bucketing, but matters if reused
 * somewhere needing ledger-exact precision.
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
  // Short timeout — "try fast, fall back otherwise," not the source of truth.
  // Any failure here falls back to the binary search in the caller.
  const data = await fetchJsonOrNull(url, { timeoutMs: 4000, headers: { Accept: 'application/json' } });
  return Number.isFinite(data?.sequence) ? data.sequence : null;
}

async function resolveViaBinarySearch(horizon, targetMs) {
  const root = await horizon.get('/');
  let hi = root.history_latest_ledger;

  // Clamp rather than binary-searching into 404s if the target is outside the
  // retained range. history_elder_ledger is the earliest ledger this Horizon
  // instance actually retains (not every instance keeps full history from
  // ledger 1) — both bounds are already in `root`, no extra request needed.
  const latest = new Date(root.history_latest_ledger_closed_at).getTime();
  if (targetMs >= latest) return hi;

  let lo = root.history_elder_ledger;
  const first = await getLedgerClosedAt(horizon, lo);
  if (targetMs <= first) return lo;

  // ~30 requests worst case for the whole pubnet history. Only reached when
  // StellarExpert is unavailable.
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
