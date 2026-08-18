import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import ChartPanel from '../components/ChartPanel.jsx';

const TOTAL_OPTION = 'Total (all protocols)';

// DeFiLlama's ranking table names Blend's 4 products separately (Pools,
// Pools V2, Backstop, Backstop V2), but the Dune-backed function-call
// breakdown (contracts.js's /protocol-functions) aggregates ALL of Blend's
// Soroban contracts into one bucket — it can't be split by product the way
// DeFiLlama's TVL rows are. All 4 Blend rows below intentionally map to the
// same aggregate key; the expanded view says so explicitly rather than
// implying each row has its own distinct breakdown.
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
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [trendSelection, setTrendSelection] = useState(TOTAL_OPTION);

  // Real function-call breakdown per protocol (server/src/routes/contracts.js's
  // /protocol-functions, Dune-backed) — fetched once alongside the ranking,
  // not per-row, since it's the same small payload regardless of which row
  // gets expanded.
  const [protocolFunctions, setProtocolFunctions] = useState(null);
  const [protocolFunctionsLoading, setProtocolFunctionsLoading] = useState(false);
  const [protocolFunctionsError, setProtocolFunctionsError] = useState(null);
  const [expandedProtocol, setExpandedProtocol] = useState(null);

  // Protocols actually worth offering in the selector — only those DeFiLlama
  // reports daily volume for (TVL-only protocols like lending have no trend data
  // to select), sorted to match the ranking table below.
  const trendOptions = useMemo(() => {
    if (!data?.available) return [];
    return data.protocols.filter((p) => data.volumeTrendByProtocol[p.name]).map((p) => p.name);
  }, [data]);

  const trendData = useMemo(() => {
    if (!data?.available) return [];
    if (trendSelection === TOTAL_OPTION) return data.volumeTrend;
    return data.volumeTrendByProtocol[trendSelection] || [];
  }, [data, trendSelection]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setTrendSelection(TOTAL_OPTION);
    setExpandedProtocol(null);
    // Without this, a failed refetch (network switch, or a transient
    // DeFiLlama error) would leave the previous network's ranking table/chart
    // on screen, rendered alongside the new error, with nothing marking it stale.
    setData(null);
    api
      .protocolsRanking(network)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [network]);

  useEffect(() => {
    let cancelled = false;
    setProtocolFunctionsLoading(true);
    setProtocolFunctionsError(null);
    // Without this, switching networks (or a transient failure) leaves the
    // previous network's function-call data in place — expanding a protocol
    // row that exists under both networks would silently show stale numbers.
    setProtocolFunctions(null);
    api
      .contractsProtocolFunctions(network)
      .then((d) => !cancelled && setProtocolFunctions(d))
      .catch((e) => !cancelled && setProtocolFunctionsError(e.message))
      .finally(() => !cancelled && setProtocolFunctionsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [network]);

  // If the fetched protocol list no longer contains the currently-selected
  // protocol (network switch, or DeFiLlama's tracked set shifting between
  // fetches), fall back to the total rather than leaving the <select> pointed
  // at an option that no longer exists (which silently shows an empty chart
  // labeled with a stale protocol name).
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
