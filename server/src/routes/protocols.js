import { Router } from 'express';
import { cached, TTL } from '../cache.js';
import { fetchJsonOrThrow } from '../fetchWithTimeout.js';
import { TREND_DAYS } from '../config.js';

const router = Router();

// DeFiLlama — free, no-auth. Neither endpoint has a Horizon/Soroban
// equivalent: there's no concept of "a protocol" at the ledger level, only
// raw contract calls (see contracts.js's function-name breakdown for that
// angle). Third-party pre-aggregation here is doing something structurally
// impossible to compute from our own upstream sources, not just cheaper.
//   GET /protocols            -> TVL per protocol, `chains`/`chainTvls`
//   GET /overview/dexs/{chain} -> trading volume per protocol
const PROTOCOLS_URL = 'https://api.llama.fi/protocols';
// totalDataChart is a daily volume time series: [ [unixSeconds, usd], ... ],
// trimmed to a trailing window (TREND_DAYS, shared with growth.js's
// /account-trend) before reaching the client. totalDataChartBreakdown is the
// same shape split per protocol: [ [unixSeconds, { protocolName: usd }], ... ]
// — powers the per-protocol line selector on the trend chart.
const DEX_VOLUME_URL = 'https://api.llama.fi/overview/dexs/stellar';

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
      // Promise.allSettled, not Promise.all — two independent calls to the
      // same third party (no SLA); the merge logic below tolerates missing
      // data from either side, so a transient failure on just the volume
      // endpoint shouldn't take down a TVL-only ranking.
      const [allProtocolsResult, dexOverviewResult] = await Promise.allSettled([
        fetchJson(PROTOCOLS_URL),
        fetchJson(DEX_VOLUME_URL),
      ]);

      // If BOTH failed, this is a genuine outage, not partial data — falling
      // through would cache a fake `{ available: true, protocols: [] }` and
      // serve it as gospel for a full TTL.HOURLY. Throwing here means
      // cached() never stores anything and the route returns a real error.
      if (allProtocolsResult.status === 'rejected' && dexOverviewResult.status === 'rejected') {
        throw allProtocolsResult.reason;
      }
      const allProtocols = allProtocolsResult.status === 'fulfilled' ? allProtocolsResult.value : [];
      const dexOverview = dexOverviewResult.status === 'fulfilled' ? dexOverviewResult.value : {};

      // Joined by name — NOT by DeFiLlama's `parentProtocol` field. That field
      // groups multiple genuinely DIFFERENT products under one shared parent
      // (e.g. Blend Pools, Pools V2, Backstop, and Backstop V2 all share
      // `parent#blend` despite being four distinct products), so joining on it
      // would silently collapse them into one row. Name is the right join key
      // for the common case.
      //
      // One confirmed exception: DeFiLlama lists the same Allbridge product as
      // "Allbridge Core" in /protocols but "Allbridge Classic" in
      // /overview/dexs/stellar — handled with an explicit alias rather than a
      // blanket join key that would risk merging unrelated same-parent
      // products again.
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
      // The CEX exclusion is re-applied here too — without it, a CEX-category
      // protocol excluded from the TVL loop above could sneak back in via its
      // DEX-volume entry.
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

      // Combined daily DEX volume across every tracked Stellar protocol,
      // already daily-bucketed by DeFiLlama — only reformatted and windowed here.
      const cutoffSec = Math.floor(Date.now() / 1000) - TREND_DAYS * 86400;
      const volumeTrend = (dexOverview.totalDataChart || [])
        .filter(([ts]) => ts >= cutoffSec)
        .map(([ts, usd]) => ({ day: new Date(ts * 1000).toISOString().slice(0, 10), volumeUsd: usd }));

      // Same daily series, split per protocol instead of summed — only kept
      // for protocols that survived the CEX filter above, so a selector built
      // from this can't offer a protocol that isn't in the ranking table.
      // Raw names (e.g. "Allbridge Classic") are run through the same alias
      // map so trend data isn't silently dropped for that one protocol.
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
