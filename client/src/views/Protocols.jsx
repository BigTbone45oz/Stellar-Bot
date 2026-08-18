import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import ChartPanel from '../components/ChartPanel.jsx';
import { useAsyncResource } from '../hooks/useAsyncResource.js';

const TOTAL_OPTION = 'Total (all protocols)';

// DeFiLlama lists Blend's 4 products separately, but the Dune-backed function-call
// breakdown can't split by product — all 4 map to one aggregate key here.
const PROTOCOL_FUNCTIONS_ALIAS = {
  Soroswap: 'Soroswap',
  'Sushi Stellar': 'Sushi',
  'Phoenix DeFi Hub': 'Phoenix',
  'Blend Pools V2': 'Blend',
  'Blend Pools': 'Blend',
  'Blend Backstop': 'Blend',
  'Blend Backstop V2': 'Blend',
};

function formatUsd(n) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function formatPct(n) {
  if (n === null || n === undefined) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

export default function Protocols({ network }) {
  const [trendSelection, setTrendSelection] = useState(TOTAL_OPTION);
  const [expandedProtocol, setExpandedProtocol] = useState(null);

  const { data, error, loading } = useAsyncResource(() => api.protocolsRanking(network), [network], {
    // Reset selections on a failed/network-switch refetch so they don't keep
    // pointing at the old network's protocol names.
    onReset: () => {
      setTrendSelection(TOTAL_OPTION);
      setExpandedProtocol(null);
    },
  });

  // Fetched once alongside the ranking (not per-row) — same small payload regardless
  // of which row is expanded.
  const {
    data: protocolFunctions,
    error: protocolFunctionsError,
    loading: protocolFunctionsLoading,
  } = useAsyncResource(() => api.contractsProtocolFunctions(network), [network]);

  // Only protocols DeFiLlama reports daily volume for (TVL-only ones have no trend data).
  const trendOptions = useMemo(() => {
    if (!data?.available) return [];
    return data.protocols.filter((p) => data.volumeTrendByProtocol[p.name]).map((p) => p.name);
  }, [data]);

  const trendData = useMemo(() => {
    if (!data?.available) return [];
    if (trendSelection === TOTAL_OPTION) return data.volumeTrend;
    return data.volumeTrendByProtocol[trendSelection] || [];
  }, [data, trendSelection]);

  // Fall back to the total if the selected protocol drops out of the fetched list
  // (network switch, or DeFiLlama's tracked set shifting) rather than leaving the
  // <select> pointed at an option that no longer exists.
  useEffect(() => {
    if (trendSelection !== TOTAL_OPTION && !trendOptions.includes(trendSelection)) {
      setTrendSelection(TOTAL_OPTION);
    }
  }, [trendOptions, trendSelection]);

  return (
    <div className="view">
      <h3 className="section-title">Protocols live on Stellar</h3>
      <p className="view-hint">
        Ranked by all-time trading volume where DeFiLlama tracks it (the closest real signal to
        "assets moved through the program"), falling back to current TVL for protocols they only
        track by value locked. Sourced from DeFiLlama (api.llama.fi) — a third-party aggregator,
        not Horizon/Soroban RPC, since there's no on-chain registry of "protocols" to query
        directly. Centralized exchanges are excluded even though DeFiLlama tracks their Stellar
        holdings — they aren't programs running on this network.
      </p>

      {loading && <div className="chart-state">Loading…</div>}
      {error && <div className="chart-state error">{error}</div>}

      {!loading && !error && data && !data.available && <div className="chart-state">{data.reason}</div>}

      {!loading && data?.available && (
        <>
          <div className="stat-row">
            <StatCard label="Protocols tracked" value={data.protocols.length} />
            <StatCard label="Total TVL" value={formatUsd(data.totalTvlUsd)} />
            <StatCard label="Total all-time volume" value={formatUsd(data.totalVolumeAllTimeUsd)} />
          </div>

          <h4 className="subhead-label">Trading volume trend, last 180 days</h4>
          <p className="view-hint">
            Combined daily DEX volume across every tracked Stellar protocol, or pick a single
            protocol's own line — is trading activity growing or shrinking, network-wide or for
            one program specifically.
          </p>
          <div className="search-row">
            <select
              className="window-select"
              value={trendSelection}
              onChange={(e) => setTrendSelection(e.target.value)}
            >
              <option value={TOTAL_OPTION}>{TOTAL_OPTION}</option>
              {trendOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <ChartPanel
            title={`Daily trading volume (USD) — ${trendSelection}`}
            loading={loading}
            error={error}
            data={trendData}
            dataKey="volumeUsd"
            xKey="day"
            kind="line"
          />

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Protocol</th>
                  <th>Category</th>
                  <th>All-time volume</th>
                  <th>24h volume</th>
                  <th>24h change</th>
                  <th>TVL</th>
                </tr>
              </thead>
              <tbody>
                {data.protocols.map((p, i) => {
                  const functionsKey = PROTOCOL_FUNCTIONS_ALIAS[p.name];
                  const expandable = Boolean(functionsKey);
                  const isExpanded = expandedProtocol === p.name;
                  return (
                    <Fragment key={p.name}>
                      <tr
                        className={expandable ? 'row-clickable' : undefined}
                        onClick={expandable ? () => setExpandedProtocol(isExpanded ? null : p.name) : undefined}
                      >
                        <td>{i + 1}</td>
                        <td>
                          {p.logo && <img src={p.logo} alt="" className="protocol-logo" />}
                          {p.name}
                          {expandable && <span className="expand-indicator">{isExpanded ? '▾' : '▸'}</span>}
                        </td>
                        <td>{p.category || '—'}</td>
                        <td>{formatUsd(p.volumeAllTimeUsd)}</td>
                        <td>{formatUsd(p.volume24hUsd)}</td>
                        <td>{formatPct(p.change1d)}</td>
                        <td>{formatUsd(p.tvlUsd)}</td>
                      </tr>
                      {isExpanded && (
                        <tr className="asset-detail-row">
                          <td colSpan={7}>
                            <div className="asset-detail">
                              {functionsKey === 'Blend' && (
                                <p className="view-hint">
                                  Blend's Soroban contracts (all products: Pools, Pools V2, Backstop,
                                  Backstop V2) are tracked as one aggregate below — Dune can't split
                                  function calls back out by which specific product they hit.
                                </p>
                              )}
                              {protocolFunctionsLoading && <div className="chart-state">Loading…</div>}
                              {protocolFunctionsError && (
                                <div className="chart-state error">{protocolFunctionsError}</div>
                              )}
                              {!protocolFunctionsLoading &&
                                !protocolFunctionsError &&
                                protocolFunctions &&
                                !protocolFunctions.available && (
                                  <div className="chart-state">{protocolFunctions.reason}</div>
                                )}
                              {!protocolFunctionsLoading &&
                                protocolFunctions?.available &&
                                (() => {
                                  const fn = protocolFunctions.protocols[functionsKey];
                                  if (!fn) {
                                    return (
                                      <div className="chart-state">
                                        No function-call data available for {p.name} yet.
                                      </div>
                                    );
                                  }
                                  return (
                                    <>
                                      <p className="view-hint">
                                        {fn.totalCalls.toLocaleString()} real function calls, all time —
                                        not filtered by trade detection, so this covers every real use
                                        (lending actions, liquidity management, etc.), not just swaps.
                                      </p>
                                      <div className="table-wrap">
                                        <table>
                                          <thead>
                                            <tr>
                                              <th>#</th>
                                              <th>Function</th>
                                              <th>Calls, all time</th>
                                            </tr>
                                          </thead>
                                          <tbody>
                                            {fn.functionTotals.map((f, idx) => (
                                              <tr key={f.name}>
                                                <td>{idx + 1}</td>
                                                <td>{f.name}</td>
                                                <td>{f.callCount.toLocaleString()}</td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    </>
                                  );
                                })()}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {data.protocols.length === 0 && (
            <div className="chart-state">No on-chain Stellar protocols currently tracked by DeFiLlama.</div>
          )}
        </>
      )}
    </div>
  );
}
