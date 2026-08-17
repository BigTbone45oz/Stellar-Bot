import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import ChartPanel from '../components/ChartPanel.jsx';
import { defaultRange } from '../dateUtils.js';
import { operationTypeLabel } from '../opTypes.js';

function formatUsd(n) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

// Fixed, not user-adjustable — this page is a glance-at-a-dashboard summary,
// not an exploration tool (that's what the dedicated tabs are for). 24h matches
// PaymentsOperations.jsx's own default for the same route.
const RECENT_OPS_RANGE = defaultRange(24);

export default function Overview({ network }) {
  const [overview, setOverview] = useState(null);
  const [ledgers, setLedgers] = useState([]);
  const [error, setError] = useState(null);

  // Both the 30s interval and the visibilitychange handler can call load()
  // independently, so two calls can be in flight at once — without this, a
  // slow interval-triggered call finishing after a faster visibilitychange-
  // triggered one could overwrite fresher data with staler data. Same
  // request-generation pattern as the manual lookups in Accounts/Trades/Assets.
  const requestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // Skip while the tab is hidden — no point polling Horizon for a chart
      // nobody's looking at. Refreshes immediately on visibilitychange below
      // instead, so data isn't stale when the user comes back.
      if (document.visibilityState === 'hidden') return;
      const myRequestId = ++requestIdRef.current;
      try {
        const [o, l] = await Promise.all([api.overview(network), api.recentLedgers(network, 10)]);
        if (!cancelled && requestIdRef.current === myRequestId) {
          setOverview(o);
          setLedgers(l);
          setError(null);
        }
      } catch (e) {
        if (!cancelled && requestIdRef.current === myRequestId) setError(e.message);
      }
    }
    load();
    const id = setInterval(load, 30_000);
    document.addEventListener('visibilitychange', load);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', load);
    };
  }, [network]);

  // Everything below is a summary of the other tabs' own data — fetched once per
  // network, NOT on the 30s poll above. That poll exists because network health
  // (latest ledger, base fee) genuinely changes every few seconds; these don't —
  // they're backed by Dune (cached server-side for hours) or DeFiLlama (cached
  // hourly) or a 24h Horizon operations window, none of which benefit from
  // being re-fetched every 30s. Re-polling them that often would just be wasted
  // requests against data that hasn't changed, the same class of inefficiency
  // this codebase has specifically avoided elsewhere (see cache.js's TTL tiers).
  const [contractsAllTime, setContractsAllTime] = useState(null);
  const [contractsAllTimeError, setContractsAllTimeError] = useState(null);
  const [protocolTrend, setProtocolTrend] = useState(null);
  const [protocolTrendError, setProtocolTrendError] = useState(null);
  const [networkTrades, setNetworkTrades] = useState(null);
  const [networkTradesError, setNetworkTradesError] = useState(null);
  const [protocolsRanking, setProtocolsRanking] = useState(null);
  const [protocolsRankingError, setProtocolsRankingError] = useState(null);
  const [topAssets, setTopAssets] = useState([]);
  const [topAssetsError, setTopAssetsError] = useState(null);
  const [recentOps, setRecentOps] = useState(null);
  const [recentOpsError, setRecentOpsError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    api.contractsAllTime(network).then((d) => !cancelled && setContractsAllTime(d)).catch((e) => !cancelled && setContractsAllTimeError(e.message));
    api.contractsProtocolTrend(network).then((d) => !cancelled && setProtocolTrend(d)).catch((e) => !cancelled && setProtocolTrendError(e.message));
    api.contractsNetworkTradingActivity(network).then((d) => !cancelled && setNetworkTrades(d)).catch((e) => !cancelled && setNetworkTradesError(e.message));
    api.protocolsRanking(network).then((d) => !cancelled && setProtocolsRanking(d)).catch((e) => !cancelled && setProtocolsRankingError(e.message));
    api.topAssets(network).then((d) => !cancelled && setTopAssets(d)).catch((e) => !cancelled && setTopAssetsError(e.message));
    api
      .opsBreakdown(network, RECENT_OPS_RANGE.start, RECENT_OPS_RANGE.end)
      .then((d) => !cancelled && setRecentOps(d))
      .catch((e) => !cancelled && setRecentOpsError(e.message));
    return () => {
      cancelled = true;
    };
  }, [network]);

  const byTypeLabeled = useMemo(
    () => recentOps?.byType.map((r) => ({ ...r, label: operationTypeLabel(r.type) })),
    [recentOps]
  );

  const topTradeFunctions = useMemo(
    () => (networkTrades?.functionTotals || []).slice(0, 6),
    [networkTrades]
  );

  const topAssetsByMarketCap = useMemo(
    () => [...topAssets].filter((a) => a.marketCapUsd !== null).sort((a, b) => b.marketCapUsd - a.marketCapUsd).slice(0, 5),
    [topAssets]
  );

  return (
    <div className="view">
      <div className="stat-row">
        <StatCard label="Latest Ledger" value={overview?.latestLedger?.toLocaleString()} />
        <StatCard label="Protocol" value={overview ? `v${overview.protocolVersion}` : null} />
        <StatCard
          label="Base Fee"
          value={overview ? `${(overview.baseFeeStroops / 1e7).toFixed(7)} XLM` : null}
        />
        <StatCard
          label="Base Reserve"
          value={overview ? `${(overview.baseReserveStroops / 1e7).toFixed(2)} XLM` : null}
        />
        <StatCard label="Horizon" value={overview?.horizonVersion} />
      </div>
      {error && <div className="chart-state error">{error}</div>}

      <h3 className="section-title">Recent Ledgers</h3>
      <div className="ledger-stream">
        {ledgers.map((l) => (
          <div className="star-node" key={l.sequence}>
            <div className="pip" />
            <div className="seq">#{l.sequence.toLocaleString()}</div>
            <div className="meta">{new Date(l.closedAt).toLocaleTimeString()}</div>
            <div className="txcount">
              {l.transactionCount} txs · {l.operationCount} ops
            </div>
          </div>
        ))}
      </div>

      <h3 className="section-title">Smart contract activity</h3>
      {contractsAllTimeError && <div className="chart-state error">{contractsAllTimeError}</div>}
      {contractsAllTime && !contractsAllTime.available && (
        <div className="chart-state">{contractsAllTime.reason}</div>
      )}
      {contractsAllTime?.available && (
        <div className="stat-row">
          <StatCard label="Value moved through contracts, all time" value={formatUsd(contractsAllTime.totalMovedUsd)} />
        </div>
      )}
      {protocolTrendError && <div className="chart-state error">{protocolTrendError}</div>}
      {protocolTrend && !protocolTrend.available && <div className="chart-state">{protocolTrend.reason}</div>}
      {(protocolTrend?.available || (!protocolTrend && !protocolTrendError)) && (
        <ChartPanel
          title="Soroswap calls per day"
          loading={!protocolTrend}
          error={null}
          data={protocolTrend?.daily}
          dataKey="invokeCount"
          xKey="day"
          kind="line"
        />
      )}
      {networkTradesError && <div className="chart-state error">{networkTradesError}</div>}
      {networkTrades && !networkTrades.available && <div className="chart-state">{networkTrades.reason}</div>}
      {(topTradeFunctions.length > 0 || (!networkTrades && !networkTradesError)) && (
        <ChartPanel
          title="Most-called trade functions, network-wide (all time)"
          loading={!networkTrades}
          error={null}
          data={topTradeFunctions}
          dataKey="callCount"
          xKey="name"
          kind="bar"
          xAngle={-30}
        />
      )}

      <h3 className="section-title">On-chain protocols</h3>
      {protocolsRankingError && <div className="chart-state error">{protocolsRankingError}</div>}
      {protocolsRanking && !protocolsRanking.available && (
        <div className="chart-state">{protocolsRanking.reason}</div>
      )}
      {protocolsRanking?.available && (
        <>
          <div className="stat-row">
            <StatCard label="Total TVL" value={formatUsd(protocolsRanking.totalTvlUsd)} />
            <StatCard label="Total all-time volume" value={formatUsd(protocolsRanking.totalVolumeAllTimeUsd)} />
          </div>
          <ChartPanel
            title="Trading volume, last 180 days"
            loading={false}
            error={protocolsRankingError}
            data={protocolsRanking.volumeTrend}
            dataKey="volumeUsd"
            xKey="day"
            kind="line"
          />
        </>
      )}

      <h3 className="section-title">Operations, last 24h</h3>
      <ChartPanel
        title="Operations by type"
        loading={!recentOps && !recentOpsError}
        error={recentOpsError}
        data={byTypeLabeled}
        dataKey="count"
        xKey="label"
        kind="bar"
        xAngle={-40}
      />

      {(topAssetsByMarketCap.length > 0 || topAssetsError) && (
        <>
          <h3 className="section-title">Top assets by market cap</h3>
          <ChartPanel
            title="Top 5 assets"
            loading={topAssets.length === 0 && !topAssetsError}
            error={topAssetsError}
            data={topAssetsByMarketCap}
            dataKey="marketCapUsd"
            xKey="code"
            kind="bar"
          />
        </>
      )}
    </div>
  );
}
