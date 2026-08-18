import { useMemo } from 'react';
import { api } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import ChartPanel from '../components/ChartPanel.jsx';
import { defaultRange } from '../dateUtils.js';
import { operationTypeLabel } from '../opTypes.js';
import { useAsyncResource } from '../hooks/useAsyncResource.js';
import { usePolledResource } from '../hooks/usePolledResource.js';

function formatUsd(n) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export default function Overview({ network }) {
  // Only network health (latest ledger, base fee) is polled — it changes every
  // few seconds. Everything below is fetched once per network: it's backed by
  // Dune/DeFiLlama caches or a 24h window, none of which change fast enough to
  // justify re-fetching every 30s.
  const { data: overview, error } = usePolledResource(() => api.overview(network), [network], { intervalMs: 30_000 });

  const { data: contractsAllTime, error: contractsAllTimeError } = useAsyncResource(
    () => api.contractsAllTime(network),
    [network]
  );
  const { data: protocolTrend, error: protocolTrendError } = useAsyncResource(
    () => api.contractsProtocolTrend(network),
    [network]
  );
  const { data: networkTrades, error: networkTradesError } = useAsyncResource(
    () => api.contractsNetworkTradingActivity(network),
    [network]
  );
  const { data: protocolsRanking, error: protocolsRankingError } = useAsyncResource(
    () => api.protocolsRanking(network),
    [network]
  );
  const { data: topAssets, error: topAssetsError } = useAsyncResource(() => api.topAssets(network), [network]);
  const { data: recentOps, error: recentOpsError } = useAsyncResource(() => {
    // Computed fresh per fetch so "last 24h" stays accurate without re-triggering on every render.
    const recentOpsRange = defaultRange(24);
    return api.opsBreakdown(network, recentOpsRange.start, recentOpsRange.end);
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
    () => (topAssets || []).filter((a) => a.marketCapUsd !== null).sort((a, b) => b.marketCapUsd - a.marketCapUsd).slice(0, 5),
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

      <h3 className="section-title">Network growth, last 24h</h3>
      <p className="view-hint">
        New accounts, funding, and trustline activity — see the Network Growth tab for the
        full trend over a wider range.
      </p>
      <div className="stat-row">
        <StatCard label="New accounts" value={recentOps ? recentOps.newAccountCount.toLocaleString() : null} />
        <StatCard
          label="XLM used to fund new accounts"
          value={recentOps ? Number(recentOps.newAccountFundingXlm).toLocaleString(undefined, { maximumFractionDigits: 2 }) : null}
        />
        <StatCard label="Trustline changes" value={recentOps ? recentOps.newTrustlineCount.toLocaleString() : null} />
      </div>
      {recentOpsError && <div className="chart-state error">{recentOpsError}</div>}

      <h3 className="section-title">Smart contract activity</h3>
      {!contractsAllTime && !contractsAllTimeError && <div className="chart-state">Loading…</div>}
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
      {(networkTrades?.available || (!networkTrades && !networkTradesError)) && (
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
      {!protocolsRanking && !protocolsRankingError && <div className="chart-state">Loading…</div>}
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

      <h3 className="section-title">Top assets by market cap</h3>
      <ChartPanel
        title="Top 5 assets"
        loading={!topAssets && !topAssetsError}
        error={topAssetsError}
        data={topAssetsByMarketCap}
        dataKey="marketCapUsd"
        xKey="code"
        kind="bar"
      />
    </div>
  );
}
