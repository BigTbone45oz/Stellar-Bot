import { Router } from 'express';
import { cached, TTL } from '../cache.js';
import { httpError } from '../httpError.js';

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

async function fetchJson(url, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw httpError(502, `DeFiLlama request failed (${res.status})`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw httpError(504, `DeFiLlama request to ${url} timed out after ${timeoutMs}ms`);
    if (err.status) throw err;
    throw httpError(502, `DeFiLlama request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
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
      const [allProtocols, dexOverview] = await Promise.all([
        fetchJson(PROTOCOLS_URL),
        fetchJson(DEX_VOLUME_URL),
      ]);

      const byName = new Map();

      for (const p of allProtocols) {
        if (!Array.isArray(p.chains) || !p.chains.includes('Stellar')) continue;
        if (EXCLUDED_CATEGORIES.has(p.category)) continue;
        byName.set(p.name, {
          name: p.name,
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
      // merge by name rather than assuming the two lists line up. Re-applying the
      // CEX exclusion here too: this loop used to unconditionally set into byName,
      // which meant a CEX-category protocol absent from (or filtered out of) the
      // TVL loop above could still get inserted via its DEX-volume entry — a real
      // bug that defeated the exclusion for exactly the rows it existed to catch.
      for (const p of dexOverview.protocols || []) {
        if (EXCLUDED_CATEGORIES.has(p.category)) continue;
        const existing = byName.get(p.name) || {
          name: p.name,
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
        byName.set(p.name, existing);
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
      // names that survived the CEX filter above, so a selector built from this
      // can't offer a protocol that isn't in the ranking table.
      const rankedNames = new Set(protocols.map((p) => p.name));
      const volumeTrendByProtocol = {};
      for (const [ts, byProtocolUsd] of dexOverview.totalDataChartBreakdown || []) {
        if (ts < cutoffSec) continue;
        const day = new Date(ts * 1000).toISOString().slice(0, 10);
        for (const [name, usd] of Object.entries(byProtocolUsd || {})) {
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
