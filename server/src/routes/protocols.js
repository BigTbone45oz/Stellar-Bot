import { Router } from 'express';
import { cached, TTL } from '../cache.js';
import { fetchJsonOrThrow } from '../fetchWithTimeout.js';

const router = Router();

// DeFiLlama — free, no-auth, no rate limit documented for this usage level.
// Verified live (not assumed) against the real endpoints before wiring this up:
//   GET https://api.llama.fi/protocols            -> TVL per protocol, `chains`/`chainTvls`
//   GET https://api.llama.fi/overview/dexs/{chain} -> trading volume per protocol
// Neither endpoint has a Horizon/Soroban equivalent — there's no concept of "a
// protocol" at the ledger level, only raw contract calls (see contracts.js's
// function-name breakdown for that angle). This is a case where third-party
// pre-aggregation is doing something structurally impossible to compute from our
// own upstream sources, not just something cheaper.
const PROTOCOLS_URL = 'https://api.llama.fi/protocols';
// totalDataChart intentionally NOT excluded here (unlike a first pass at this route)
// — it's a real daily volume time series (verified live: 1,598 days back to April
// 2022), the actual data this project's stated goal needs ("trends... how often
// used"), and we're already paying for the request either way. Trimmed to a
// trailing window server-side before it reaches the client (see TREND_DAYS) so we
// ship a chart-sized payload, not years of daily points on every page load.
// totalDataChartBreakdown also included now (per-protocol daily volume, same shape
// as totalDataChart but split out: [ [unixSeconds, { protocolName: usd }], ... ]) —
// powers the per-protocol line selector on the trend chart.
const DEX_VOLUME_URL = 'https://api.llama.fi/overview/dexs/stellar';
const TREND_DAYS = 180;

// CEXs (Binance, Gate, Poloniex, ...) show up in DeFiLlama's Stellar TVL list
// because they custody Stellar assets off-chain — they're not programs running
// on Stellar. Excluding them is what makes this an actual ranking of on-chain
// protocols rather than "who holds the most XLM/USDC", which is a different and
// much less interesting question than the one this page is answering.
const EXCLUDED_CATEGORIES = new Set(['CEX']);

function fetchJson(url, timeoutMs = 10_000) {
  return fetchJsonOrThrow(url, { timeoutMs, headers: { Accept: 'application/json' }, label: 'DeFiLlama request' });
}

// DeFiLlama has no per-chain protocol-TVL endpoint, so /protocols returns every
// protocol on every chain (thousands) — filtered down here to just the ones with
// a Stellar entry in their `chains` array.
router.get('/ranking', async (req, res, next) => {
  try {
    const network = req.query.network === 'testnet' ? 'testnet' : 'pubnet';
    if (network !== 'pubnet') {
      return res.json({ available: false, reason: 'Protocol rankings are pubnet-only — DeFiLlama doesn\'t track Stellar testnet.' });
    }

    const data = await cached('protocolsRanking:pubnet', TTL.HOURLY, async () => {
      // Promise.allSettled, not Promise.all — these are two independent calls
      // to the same third party (no SLA), and the merge logic below already
      // tolerates missing data from either side (every field it reads has an
      // `|| []`/`|| null` fallback). A transient failure on just the volume
      // endpoint shouldn't take down a TVL-only ranking that would otherwise
      // have rendered fine — same "degrade rather than fail" principle this
      // codebase applies to every other best-effort external call.
      const [allProtocolsResult, dexOverviewResult] = await Promise.allSettled([
        fetchJson(PROTOCOLS_URL),
        fetchJson(DEX_VOLUME_URL),
      ]);
      const allProtocols = allProtocolsResult.status === 'fulfilled' ? allProtocolsResult.value : [];
      const dexOverview = dexOverviewResult.status === 'fulfilled' ? dexOverviewResult.value : {};

      // Joined by name — NOT by DeFiLlama's `parentProtocol` field. That field
      // groups multiple genuinely DIFFERENT products under one shared parent
      // (e.g. Blend Pools, Blend Pools V2, Blend Backstop, and Blend Backstop
      // V2 all share `parent#blend` despite being four distinct products) — an
      // earlier version of this route joined by parentProtocol and silently
      // collapsed all four into a single row, losing three real, distinct
      // protocols from the ranking. Name is the right join key for the common
      // case (verified live: Soroswap, Scopuly, Aquarius Stellar, and the four
      // Blend products all match cleanly by name across both endpoints).
      //
      // The one confirmed exception: DeFiLlama lists the same underlying
      // Allbridge product under "Allbridge Core" in /protocols but
      // "Allbridge Classic" in /overview/dexs/stellar — a real cross-endpoint
      // naming inconsistency for one specific protocol, not a general pattern,
      // so it's handled with an explicit alias rather than a blanket join key
      // that would risk merging unrelated same-parent products again.
      const NAME_ALIASES = { 'Allbridge Classic': 'Allbridge Core' };
      const canonicalName = (name) => NAME_ALIASES[name] || name;

      const byName = new Map();

      for (const p of allProtocols) {
        if (!Array.isArray(p.chains) || !p.chains.includes('Stellar')) continue;
        if (EXCLUDED_CATEGORIES.has(p.category)) continue;
        byName.set(canonicalName(p.name), {
          name: canonicalName(p.name),
          category: p.category || null,
          logo: p.logo || null,
          tvlUsd: typeof p.chainTvls?.Stellar === 'number' ? p.chainTvls.Stellar : null,
          volume24hUsd: null,
          volume7dUsd: null,
          volumeAllTimeUsd: null,
          change1d: null,
        });
      }

      // Volume entries can name a protocol /protocols didn't (or vice versa) —
      // merge by (aliased) name rather than assuming the two lists line up.
      // Re-applying the CEX exclusion here too: this loop used to unconditionally
      // set into the map, which meant a CEX-category protocol absent from (or
      // filtered out of) the TVL loop above could still get inserted via its
      // DEX-volume entry — a real bug that defeated the exclusion for exactly
      // the rows it existed to catch.
      for (const p of dexOverview.protocols || []) {
        if (EXCLUDED_CATEGORIES.has(p.category)) continue;
        const key = canonicalName(p.name);
        const existing = byName.get(key) || {
          name: key,
          category: p.category || null,
          logo: p.logo || null,
          tvlUsd: null,
          volume24hUsd: null,
          volume7dUsd: null,
          volumeAllTimeUsd: null,
          change1d: null,
        };
        existing.volume24hUsd = typeof p.total24h === 'number' ? p.total24h : null;
        existing.volume7dUsd = typeof p.total7d === 'number' ? p.total7d : null;
        existing.volumeAllTimeUsd = typeof p.totalAllTime === 'number' ? p.totalAllTime : null;
        existing.change1d = typeof p.change_1d === 'number' ? p.change_1d : null;
        byName.set(key, existing);
      }

      const protocols = Array.from(byName.values()).sort((a, b) => {
        // "Total assets being moved through the program" is volume, not TVL —
        // rank by all-time volume first (what was asked for), TVL as a tiebreak
        // for protocols DeFiLlama only tracks by TVL (no DEX volume, e.g. lending).
        if (a.volumeAllTimeUsd !== null && b.volumeAllTimeUsd !== null) return b.volumeAllTimeUsd - a.volumeAllTimeUsd;
        if (a.volumeAllTimeUsd !== null) return -1;
        if (b.volumeAllTimeUsd !== null) return 1;
        return (b.tvlUsd || 0) - (a.tvlUsd || 0);
      });

      // Combined daily DEX volume across every tracked Stellar protocol — the
      // ecosystem-level "how much trading activity is happening, and is it
      // growing or shrinking" trend. `totalDataChart` is [ [unixSeconds, usd], ... ],
      // already daily-bucketed by DeFiLlama; only reformatted and windowed here.
      const cutoffSec = Math.floor(Date.now() / 1000) - TREND_DAYS * 86400;
      const volumeTrend = (dexOverview.totalDataChart || [])
        .filter(([ts]) => ts >= cutoffSec)
        .map(([ts, usd]) => ({ day: new Date(ts * 1000).toISOString().slice(0, 10), volumeUsd: usd }));

      // Same daily series, split per protocol instead of summed — only kept for
      // protocols that survived the CEX filter above, so a selector built from
      // this can't offer a protocol that isn't in the ranking table.
      //
      // totalDataChartBreakdown keys its entries by dexOverview's own raw names
      // (e.g. "Allbridge Classic"), which the alias map above renames to match
      // the ranking table's canonical name ("Allbridge Core") — same alias
      // lookup, so trend data isn't silently dropped for that one protocol.
      const rankedNames = new Set(protocols.map((p) => p.name));
      // Object.create(null), not {} — protocol names come from DeFiLlama, a
      // third party we don't control, so a plain {} risks the same silent
      // "__proto__" key corruption already fixed in contracts.js's analogous
      // dailyByFunction/protocols objects.
      const volumeTrendByProtocol = Object.create(null);
      for (const [ts, byProtocolUsd] of dexOverview.totalDataChartBreakdown || []) {
        if (ts < cutoffSec) continue;
        const day = new Date(ts * 1000).toISOString().slice(0, 10);
        for (const [rawName, usd] of Object.entries(byProtocolUsd || {})) {
          const name = canonicalName(rawName);
          if (!rankedNames.has(name)) continue;
          (volumeTrendByProtocol[name] ||= []).push({ day, volumeUsd: usd });
        }
      }

      return {
        available: true,
        totalTvlUsd: protocols.reduce((sum, p) => sum + (p.tvlUsd || 0), 0),
        totalVolumeAllTimeUsd: protocols.reduce((sum, p) => sum + (p.volumeAllTimeUsd || 0), 0),
        protocols,
        volumeTrend,
        volumeTrendByProtocol,
      };
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
