import { Router } from 'express';
import { resolveNetwork, DUNE_ACCOUNT_GROWTH_QUERY_ID, DUNE_TRUSTLINE_GROWTH_QUERY_ID } from '../config.js';
import { cached, TTL } from '../cache.js';
import { duneConfigured, fetchDuneQueryResults } from '../duneClient.js';

const TOP_TRUSTLINE_ASSETS_SHOWN = 15;

const router = Router();

// The underlying query covers Stellar's full history (back to 2015, ~3,950
// days as of this writing) — trimmed to a trailing window before it reaches
// the client, same reasoning as protocols.js's TREND_DAYS: a chart-sized
// payload, not a decade of daily points on every page load. Totals below are
// computed from the FULL untrimmed result, not just this window.
const TREND_DAYS = 180;

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
    if (net.key !== 'pubnet') {
      return res.json({ available: false, reason: 'Account growth trend is only meaningful on pubnet.' });
    }
    if (!duneConfigured(DUNE_ACCOUNT_GROWTH_QUERY_ID)) {
      return res.json({
        available: false,
        reason: 'Dune isn\'t configured on the server (DUNE_API_KEY/DUNE_ACCOUNT_GROWTH_QUERY_ID).',
      });
    }

    // Dune's own materialized result barely changes minute-to-minute (it only
    // refreshes when the saved query is re-run) — cached generously, same as
    // the other Dune-backed routes.
    const data = await cached('growthAccountTrend:pubnet', TTL.FINALIZED, async () => {
      const rows = await fetchDuneQueryResults(DUNE_ACCOUNT_GROWTH_QUERY_ID);

      const allDaily = rows
        .map((r) => {
          const accountsCreated = Number(r.accounts_created) || 0;
          const accountsMerged = Number(r.accounts_merged) || 0;
          return { day: r.day, accountsCreated, accountsMerged, netGrowth: accountsCreated - accountsMerged };
        })
        .sort((a, b) => (a.day < b.day ? -1 : 1));

      // All-time totals, computed before trimming — not affected by TREND_DAYS.
      const totalAccountsCreated = allDaily.reduce((sum, d) => sum + d.accountsCreated, 0);
      const totalAccountsMerged = allDaily.reduce((sum, d) => sum + d.accountsMerged, 0);

      return {
        available: true,
        daily: allDaily.slice(-TREND_DAYS),
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

// Which specific assets are actually gaining/losing trustlines, not just a
// network-wide total — same "can't come from live Horizon at this scope"
// reasoning as /account-trend above. Ranked by all-time trustline-change
// count rather than shown as a daily-per-asset trend (a lot of chart
// complexity for a first pass — worth adding later if the ranked list alone
// isn't enough).
router.get('/trustline-trend', async (req, res, next) => {
  try {
    const net = resolveNetwork(req.query.network);
    if (net.key !== 'pubnet') {
      return res.json({ available: false, reason: 'Trustline growth is only meaningful on pubnet.' });
    }
    if (!duneConfigured(DUNE_TRUSTLINE_GROWTH_QUERY_ID)) {
      return res.json({
        available: false,
        reason: 'Dune isn\'t configured on the server (DUNE_API_KEY/DUNE_TRUSTLINE_GROWTH_QUERY_ID).',
      });
    }

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

      const assetTotals = Array.from(totals.values())
        .sort((a, b) => b.changeCount - a.changeCount)
        .slice(0, TOP_TRUSTLINE_ASSETS_SHOWN);

      return {
        available: true,
        totalTrustlineChanges: Array.from(totals.values()).reduce((sum, a) => sum + a.changeCount, 0),
        assetTotals,
      };
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
