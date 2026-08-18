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

// Day-bucketed account creation/closure trend, all-time. Horizon has no
// aggregate "operations by type per day" endpoint, and enumerating raw
// /operations live hits payments.js's /breakdown record cap within hours on a
// busy network — nowhere near enough for a multi-month trend. Backed by a
// saved Dune query against stellar.history_operations instead. Pubnet-only —
// Dune doesn't index testnet, and testnet's periodic resets make an all-time
// trend meaningless there anyway.
//
// The query covers full history back to 2015; trimmed to a trailing window
// (TREND_DAYS, shared with protocols.js's /ranking) before reaching the
// client. Totals below are computed from the full untrimmed result.
router.get('/account-trend', async (req, res, next) => {
  try {
    const net = resolveNetwork(req.query.network);
    const unavailable = duneRouteUnavailable(net, DUNE_ACCOUNT_GROWTH_QUERY_ID, 'DUNE_ACCOUNT_GROWTH_QUERY_ID', 'Account growth trend');
    if (unavailable) return res.json(unavailable);

    // Dune's materialized result only changes when the saved query is
    // re-run — cached generously.
    const data = await cached('growthAccountTrend:pubnet', TTL.FINALIZED, async () => {
      const rows = await fetchDuneQueryResults(DUNE_ACCOUNT_GROWTH_QUERY_ID);

      // Grouped by day rather than assuming one row per day, in case a future
      // query re-shape produces duplicate day rows (would otherwise silently
      // shrink the calendar-day count under the cutoff filter below).
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
      // operation, so slicing the last N entries could silently reach further
      // back than N calendar days whenever a gap day exists.
      const cutoffDay = new Date(Date.now() - TREND_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const daily = allDaily.filter((d) => d.day >= cutoffDay);

      return {
        available: true,
        truncated: Boolean(rows.truncated),
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

// Per-asset trustline gain/loss, not just a network-wide total — same
// "can't come from live Horizon at this scope" reasoning as /account-trend
// above. Ranked by all-time trustline-change count rather than a
// daily-per-asset trend (simpler first pass).
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
        truncated: Boolean(rows.truncated),
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
