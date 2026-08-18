import { Router } from 'express';
import {
  resolveNetwork,
  DUNE_ACCOUNT_GROWTH_QUERY_ID,
  DUNE_TRUSTLINE_GROWTH_QUERY_ID,
  TREND_DAYS,
} from '../config.js';
import { cached, TTL } from '../cache.js';
import { fetchDuneQueryResults, duneRouteUnavailable } from '../duneClient.js';

const TOP_TRUSTLINE_ASSETS_SHOWN = 15;

const router = Router();

// The underlying query covers Stellar's full history (back to 2015, ~3,950
// days as of this writing) — trimmed to a trailing window before it reaches
// the client (TREND_DAYS, shared with protocols.js's /ranking — see
// config.js): a chart-sized payload, not a decade of daily points on every
// page load. Totals below are computed from the FULL untrimmed result, not
// just this window.

// Row shape (r.day, r.accounts_created, r.accounts_merged) verified live
// against the actual saved query (dune.com/queries/8363713): real rows came
// back with those exact keys, data spanning 2015-09-30 through today (3,949
// days), 31.2M accounts created / 13.8M merged all-time — sane numbers, not
// just a shape that happened to parse.
//
// Day-bucketed account creation/closure trend, all-time — Horizon has no
// aggregate "operations by type per day" endpoint, and enumerating raw
// /operations live (as payments.js's /breakdown does) hits a hard record cap
// within hours on a busy network (verified live: even a 6h window can exceed
// the 20,000-op cap) — nowhere near enough to show a real multi-day/week/month
// trend. Backed by a saved Dune query against stellar.history_operations
// instead, same shape as contracts.js's /all-time and /protocol-trend routes.
// Pubnet-only, same reasoning as those (Dune doesn't index testnet, and
// testnet's periodic resets make an all-time trend meaningless there anyway).
router.get('/account-trend', async (req, res, next) => {
  try {
    const net = resolveNetwork(req.query.network);
    const unavailable = duneRouteUnavailable(net, DUNE_ACCOUNT_GROWTH_QUERY_ID, 'DUNE_ACCOUNT_GROWTH_QUERY_ID', 'Account growth trend');
    if (unavailable) return res.json(unavailable);

    // Dune's own materialized result barely changes minute-to-minute (it only
    // refreshes when the saved query is re-run) — cached generously, same as
    // the other Dune-backed routes.
    const data = await cached('growthAccountTrend:pubnet', TTL.FINALIZED, async () => {
      const rows = await fetchDuneQueryResults(DUNE_ACCOUNT_GROWTH_QUERY_ID);

      // Grouped by day rather than assuming the query emits exactly one row
      // per day — same defensive shape as /trustline-trend's Map below and
      // contracts.js's /protocol-trend, in case a future query re-shape (or a
      // grouping dimension added later) ever produces duplicate day rows;
      // without this, duplicates wouldn't merge and would silently shrink the
      // number of distinct calendar days covered by the trailing-window cutoff
      // below.
      const byDay = new Map();
      for (const r of rows) {
        const entry = byDay.get(r.day) || { day: r.day, accountsCreated: 0, accountsMerged: 0 };
        entry.accountsCreated += Number(r.accounts_created) || 0;
        entry.accountsMerged += Number(r.accounts_merged) || 0;
        byDay.set(r.day, entry);
      }
      const allDaily = Array.from(byDay.values())
        .map((d) => ({ ...d, netGrowth: d.accountsCreated - d.accountsMerged }))
        .sort((a, b) => (a.day < b.day ? -1 : 1));

      // All-time totals, computed before trimming — not affected by TREND_DAYS.
      const totalAccountsCreated = allDaily.reduce((sum, d) => sum + d.accountsCreated, 0);
      const totalAccountsMerged = allDaily.reduce((sum, d) => sum + d.accountsMerged, 0);

      // Filtered by an actual date cutoff, not a trailing array slice — the
      // Dune query only emits a row for days with at least one matching
      // operation, so a day with zero account creates/merges simply has no
      // row. Slicing the last TREND_DAYS *entries* would silently reach
      // further back than TREND_DAYS *calendar days* whenever such a gap
      // exists, while still being labeled "last 180 days" on the client.
      const cutoffDay = new Date(Date.now() - TREND_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const daily = allDaily.filter((d) => d.day >= cutoffDay);

      return {
        available: true,
        daily,
        totalAccountsCreated,
        totalAccountsMerged,
        netAccountGrowth: totalAccountsCreated - totalAccountsMerged,
      };
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Row shape (r.asset_code, r.asset_issuer, r.trustline_changes) verified live
// against the actual saved query (dune.com/queries/8363720): real rows came
// back with those exact keys, 403.3M total trustline changes, top asset USDC
// at 8.08M — sane numbers, not just a shape that happened to parse.
//
// Which specific assets are actually gaining/losing trustlines, not just a
// network-wide total — same "can't come from live Horizon at this scope"
// reasoning as /account-trend above. Ranked by all-time trustline-change
// count rather than shown as a daily-per-asset trend (a lot of chart
// complexity for a first pass — worth adding later if the ranked list alone
// isn't enough).
router.get('/trustline-trend', async (req, res, next) => {
  try {
    const net = resolveNetwork(req.query.network);
    const unavailable = duneRouteUnavailable(net, DUNE_TRUSTLINE_GROWTH_QUERY_ID, 'DUNE_TRUSTLINE_GROWTH_QUERY_ID', 'Trustline growth');
    if (unavailable) return res.json(unavailable);

    const data = await cached('growthTrustlineTrend:pubnet', TTL.FINALIZED, async () => {
      const rows = await fetchDuneQueryResults(DUNE_TRUSTLINE_GROWTH_QUERY_ID);

      const totals = new Map(); // assetKey -> { code, issuer, changeCount }
      for (const r of rows) {
        const code = r.asset_code || 'XLM';
        const issuer = r.asset_issuer || null;
        const assetKey = `${code}:${issuer || ''}`;
        const entry = totals.get(assetKey) || { code, issuer, changeCount: 0 };
        entry.changeCount += Number(r.trustline_changes) || 0;
        totals.set(assetKey, entry);
      }

      const allAssets = Array.from(totals.values()).sort((a, b) => b.changeCount - a.changeCount);
      const totalTrustlineChanges = allAssets.reduce((sum, a) => sum + a.changeCount, 0);

      return {
        available: true,
        totalTrustlineChanges,
        assetTotals: allAssets.slice(0, TOP_TRUSTLINE_ASSETS_SHOWN),
      };
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
