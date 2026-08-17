import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import DateRangePicker from '../components/DateRangePicker.jsx';
import ChartPanel from '../components/ChartPanel.jsx';
import StatCard from '../components/StatCard.jsx';
import { defaultRange, OPS_BREAKDOWN_RANGE_PRESETS } from '../dateUtils.js';
import { operationTypeLabel, operationTypeDescription, hostFunctionLabel, hostFunctionDescription } from '../opTypes.js';
import { contractFunctionInfo, movementTypeDescription } from '../contractFunctions.js';

const TOP_ASSETS_SHOWN = 10;

function formatAssetAmount(n) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatUsd(n) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

const CONFIDENCE_BADGE = {
  standard: { label: 'SEP-41 standard', className: 'badge' },
  convention: { label: 'common convention', className: 'badge badge-convention' },
  unknown: { label: 'custom / unverified', className: 'badge badge-unknown' },
};

// The two Soroban-specific operation types (outside invoke_host_function itself,
// which gets split further below by its own `function` field).
const SOROBAN_OP_TYPES = ['extend_footprint_ttl', 'restore_footprint'];

export default function SmartContracts({ network }) {
  const [contractId, setContractId] = useState('');
  const [range, setRange] = useState(defaultRange(72)); // 3 days
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Network-wide totals of "what kind of smart contract operation happened" —
  // reuses the same /api/payments/breakdown route and Horizon fetch the Payments &
  // Operations tab already does (no separate contract-scoped fetch needed), just
  // filtered down to the Soroban-relevant rows and with invoke_host_function split
  // into its three underlying actions (call / deploy / upload wasm).
  const [breakdownRange, setBreakdownRange] = useState(defaultRange(24));
  const [breakdown, setBreakdown] = useState(null);
  const [breakdownLoading, setBreakdownLoading] = useState(false);
  const [breakdownError, setBreakdownError] = useState(null);

  // Since Soroban's mainnet launch, not scoped to any date range — backed by Dune
  // (see server/src/routes/contracts.js's /all-time), since scanning that much
  // Horizon history live isn't feasible.
  const [allTime, setAllTime] = useState(null);
  const [allTimeLoading, setAllTimeLoading] = useState(false);
  const [allTimeError, setAllTimeError] = useState(null);

  // Day-bucketed call-volume trend for Soroswap specifically (the one protocol
  // with confirmed-Soroban contract addresses) — see contracts.js's /protocol-trend.
  const [protocolTrend, setProtocolTrend] = useState(null);
  const [protocolTrendLoading, setProtocolTrendLoading] = useState(false);
  const [protocolTrendError, setProtocolTrendError] = useState(null);
  const [functionTrendSelection, setFunctionTrendSelection] = useState('');

  // Options come from functionTotals (already sorted by call count), so the
  // default selection is naturally the most-called function, not an arbitrary one.
  const functionTrendOptions = useMemo(
    () => (protocolTrend?.functionTotals || []).map((f) => f.name),
    [protocolTrend]
  );

  const sorobanRows = useMemo(() => {
    if (!breakdown) return [];
    const rows = [];
    for (const f of breakdown.byFunction || []) {
      rows.push({ key: f.function, label: hostFunctionLabel(f.function), description: hostFunctionDescription(f.function), count: f.count });
    }
    for (const t of breakdown.byType || []) {
      if (SOROBAN_OP_TYPES.includes(t.type)) {
        rows.push({ key: t.type, label: operationTypeLabel(t.type), description: operationTypeDescription(t.type), count: t.count });
      }
    }
    return rows.sort((a, b) => b.count - a.count);
  }, [breakdown]);

  // The actual answer to "what are people trying to do with these contracts" —
  // the specific function invoked (transfer, swap, harvest, ...), not just the
  // fact that *a* contract was called. Confidence varies per name; see
  // contractFunctions.js.
  const invokedFunctionRows = useMemo(() => {
    return (breakdown?.byInvokedFunction || []).map((r) => ({ ...r, ...contractFunctionInfo(r.name) }));
  }, [breakdown]);

  useEffect(() => {
    let cancelled = false;
    setBreakdownLoading(true);
    setBreakdownError(null);
    api
      .opsBreakdown(network, breakdownRange.start, breakdownRange.end)
      .then((d) => !cancelled && setBreakdown(d))
      .catch((e) => !cancelled && setBreakdownError(e.message))
      .finally(() => !cancelled && setBreakdownLoading(false));
    return () => {
      cancelled = true;
    };
  }, [network, breakdownRange.start, breakdownRange.end]);

  useEffect(() => {
    let cancelled = false;
    setAllTimeLoading(true);
    setAllTimeError(null);
    api
      .contractsAllTime(network)
      .then((d) => !cancelled && setAllTime(d))
      .catch((e) => !cancelled && setAllTimeError(e.message))
      .finally(() => !cancelled && setAllTimeLoading(false));
    return () => {
      cancelled = true;
    };
  }, [network]);

  useEffect(() => {
    let cancelled = false;
    setProtocolTrendLoading(true);
    setProtocolTrendError(null);
    api
      .contractsProtocolTrend(network)
      .then((d) => {
        if (cancelled) return;
        setProtocolTrend(d);
        setFunctionTrendSelection(d.available && d.functionTotals?.length > 0 ? d.functionTotals[0].name : '');
      })
      .catch((e) => !cancelled && setProtocolTrendError(e.message))
      .finally(() => !cancelled && setProtocolTrendLoading(false));
    return () => {
      cancelled = true;
    };
  }, [network]);

  useEffect(() => {
    if (!/^C[A-Z2-7]{55}$/.test(contractId)) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .contractActivity(network, contractId, range.start, range.end)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [network, contractId, range.start, range.end]);

  return (
    <div className="view">
      <h3 className="section-title">All-time asset movement through contracts</h3>
      <p className="view-hint">
        Since Soroban's mainnet launch (Feb 2024) — not affected by the date range below, which
        only scopes the graphs and swap/function-breakdown sections further down.
      </p>
      {allTimeLoading && <div className="chart-state">Loading…</div>}
      {allTimeError && <div className="chart-state error">{allTimeError}</div>}
      {!allTimeLoading && !allTimeError && allTime && !allTime.available && (
        <div className="chart-state">{allTime.reason}</div>
      )}
      {!allTimeLoading && allTime?.available && (
        <>
          <div className="stat-row">
            <StatCard label="Total moved, all time (USD)" value={formatUsd(allTime.totalMovedUsd)} />
            <StatCard label="Assets priced" value={`${allTime.pricedAssetCount} / ${allTime.assetCount}`} />
          </div>
          {allTime.pricedAssetCount < allTime.assetCount && (
            <p className="view-hint">
              {allTime.assetCount - allTime.pricedAssetCount} asset(s) had no resolvable USD price
              (still counted below by raw amount, just excluded from the USD total — so that total
              is a lower bound, not exact).
            </p>
          )}
          <h4 className="subhead-label">
            Top {Math.min(TOP_ASSETS_SHOWN, allTime.topAssets.length)} assets moved, all time
          </h4>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Asset</th>
                  <th>Total moved</th>
                  <th>USD value</th>
                </tr>
              </thead>
              <tbody>
                {allTime.topAssets.map((a, i) => (
                  <tr key={`${a.code}-${a.issuer || 'native'}`}>
                    <td>{i + 1}</td>
                    <td>{a.code}</td>
                    <td>{formatAssetAmount(a.totalAmount)}</td>
                    <td>{formatUsd(a.totalUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3 className="section-title">Soroswap usage over time</h3>
      <p className="view-hint">
        Since Soroswap's deployment (confirmed-Soroban contract addresses, via Dune). Not yet
        extended to other Stellar "DEX" protocols — Aquarius, LumenSwap, and Scopuly predate
        Soroban and run mostly or entirely on Stellar's classic protocol-level DEX/liquidity
        pools, so mixing their activity in here would overstate genuine smart-contract usage.
      </p>
      {protocolTrendLoading && <div className="chart-state">Loading…</div>}
      {protocolTrendError && <div className="chart-state error">{protocolTrendError}</div>}
      {!protocolTrendLoading && !protocolTrendError && protocolTrend && !protocolTrend.available && (
        <div className="chart-state">{protocolTrend.reason}</div>
      )}
      {!protocolTrendLoading && protocolTrend?.available && (
        <>
          <div className="stat-row">
            <StatCard label="Total calls, all time" value={protocolTrend.totalInvokeCalls.toLocaleString()} />
            <StatCard label="Pools created, all time" value={protocolTrend.totalPoolsCreated.toLocaleString()} />
          </div>
          <ChartPanel
            title="Soroswap calls per day"
            loading={protocolTrendLoading}
            error={protocolTrendError}
            data={protocolTrend.daily}
            dataKey="invokeCount"
            xKey="day"
            kind="line"
          />

          {functionTrendOptions.length > 0 && (
            <>
              <h4 className="subhead-label">What Soroswap is actually being called to do</h4>
              <p className="view-hint">
                Real decoded function names (not a heuristic guess) — the direct answer to "is
                this trading, or something else." All-time totals below; pick one to see its own
                trend over time.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Function</th>
                      <th>Calls, all time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {protocolTrend.functionTotals.map((f) => (
                      <tr key={f.name}>
                        <td>{f.name}</td>
                        <td>{f.callCount.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="search-row">
                <select
                  className="window-select"
                  value={functionTrendSelection}
                  onChange={(e) => setFunctionTrendSelection(e.target.value)}
                >
                  {functionTrendOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <ChartPanel
                title={`Daily calls — ${functionTrendSelection}`}
                loading={protocolTrendLoading}
                error={protocolTrendError}
                data={protocolTrend.dailyByFunction[functionTrendSelection] || []}
                dataKey="callCount"
                xKey="day"
                kind="line"
              />
            </>
          )}
        </>
      )}

      <h3 className="section-title">Verified asset movement through contracts</h3>
      <p className="view-hint">
        This is <em>proven</em>, not inferred — Horizon directly reports when a contract call
        moves a classic Stellar asset or a Stellar Asset Contract (SAC)-wrapped token. That's real
        evidence of trading/payment activity, but it's a partial picture: it only covers calls
        that touch classic-tracked assets — most current Soroban activity (see the function-name
        breakdown further down) is purely internal contract state that Horizon can't see at this
        level, so it won't appear here at all.
      </p>
      <DateRangePicker
        start={breakdownRange.start}
        end={breakdownRange.end}
        onChange={setBreakdownRange}
        presets={OPS_BREAKDOWN_RANGE_PRESETS}
      />
      {breakdown?.truncated && (
        <div className="chart-note-banner">
          Range is large — showing the first portion fetched. Narrow the range for a complete picture.
        </div>
      )}

      {(breakdown?.assetMovement?.length ?? 0) > 0 && (
        <>
          <div className="stat-row">
            <StatCard label="Total moved (USD)" value={formatUsd(breakdown.totalMovedUsd)} />
            <StatCard label="Assets priced" value={`${breakdown.pricedAssetCount} / ${breakdown.assetMovement.length}`} />
          </div>
          {breakdown.pricedAssetCount < breakdown.assetMovement.length && (
            <p className="view-hint">
              {breakdown.assetMovement.length - breakdown.pricedAssetCount} asset(s) had no resolvable USD
              price (still counted in the table below, just excluded from the USD total — so that total is
              a lower bound, not exact).
            </p>
          )}

          <h4 className="subhead-label">Top {Math.min(TOP_ASSETS_SHOWN, breakdown.assetMovement.length)} assets moved, by USD value</h4>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Asset</th>
                  <th>Total moved</th>
                  <th>USD value</th>
                  <th># of changes</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.assetMovement.slice(0, TOP_ASSETS_SHOWN).map((a, i) => (
                  <tr key={`${a.code}-${a.issuer || 'native'}`}>
                    <td>{i + 1}</td>
                    <td>{a.code}</td>
                    <td>{formatAssetAmount(a.total)}</td>
                    <td>{formatUsd(a.totalUsd)}</td>
                    <td>{a.changeCount.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {breakdown.assetMovement.length > TOP_ASSETS_SHOWN && (
            <p className="view-hint">
              +{breakdown.assetMovement.length - TOP_ASSETS_SHOWN} more asset(s) moved in smaller amounts this range.
            </p>
          )}
        </>
      )}

      {(breakdown?.movementByType?.length ?? 0) > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Movement type</th>
                <th>Count</th>
                <th>What it means</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.movementByType.map((t) => (
                <tr key={t.type}>
                  <td>{t.type}</td>
                  <td>{t.count.toLocaleString()}</td>
                  <td>{movementTypeDescription(t.type)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!breakdownLoading && (breakdown?.assetMovement?.length ?? 0) === 0 && (
        <div className="chart-state">
          No classic-tracked asset movement found in this range — doesn't mean nothing happened,
          just that no contract call in this window moved a classic/SAC asset (see note above).
        </div>
      )}

      <h4 className="subhead-label">Detected swaps</h4>
      <p className="view-hint">
        Contract calls that moved 2+ different assets at once in the same operation — the clearest
        available proof of an actual swap/trade happening through a contract.
      </p>
      {(breakdown?.swaps?.length ?? 0) > 0 ? (
        <ul className="tx-list">
          {breakdown.swaps.map((s) => (
            <li key={s.id}>
              <span>
                {s.transactionHash.slice(0, 10)}… · from {s.sourceAccount?.slice(0, 6)}… ·{' '}
                {new Date(s.createdAt).toLocaleString()}
              </span>
              <span>{s.legs.map((l) => `${formatAssetAmount(l.amount)} ${l.code}`).join(' ↔ ')}</span>
            </li>
          ))}
        </ul>
      ) : (
        !breakdownLoading && <div className="chart-state">No multi-asset swaps detected in this range.</div>
      )}

      <h3 className="section-title">Smart contract operations, network-wide</h3>
      <p className="view-hint">
        Totals of every kind of Soroban operation across all contracts — invocations broken out
        from deployments and wasm uploads, which share one Horizon operation type but mean very
        different things.
      </p>
      <ChartPanel
        title="Soroban operations by type"
        loading={breakdownLoading}
        error={breakdownError}
        data={sorobanRows}
        dataKey="count"
        xKey="label"
        kind="bar"
        xAngle={-30}
      />
      {sorobanRows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Operation</th>
                <th>Count</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              {sorobanRows.map((r) => (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td>{r.count.toLocaleString()}</td>
                  <td>{r.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="section-title">What people are calling contracts to do</h3>
      <p className="view-hint">
        The specific function invoked on each call (decoded from the transaction, same date range
        as above) — a much more direct signal than "a contract was invoked." "SEP-41 standard"
        functions are guaranteed by that spec; "common convention" is an educated guess from
        naming patterns seen across Soroban contracts, not a guarantee; "custom" means it isn't
        recognized at all — could be anything, including a contract-specific or game-specific verb.
      </p>
      <ChartPanel
        title="Most-called contract functions"
        loading={breakdownLoading}
        error={breakdownError}
        data={invokedFunctionRows}
        dataKey="count"
        xKey="name"
        kind="bar"
        xAngle={-30}
      />
      {invokedFunctionRows.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Function</th>
                <th>Count</th>
                <th>Confidence</th>
                <th>What it likely does</th>
              </tr>
            </thead>
            <tbody>
              {invokedFunctionRows.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}</td>
                  <td>{r.count.toLocaleString()}</td>
                  <td>
                    <span className={`${CONFIDENCE_BADGE[r.confidence].className} badge-sm`}>
                      {CONFIDENCE_BADGE[r.confidence].label}
                    </span>
                  </td>
                  <td>{r.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="section-title">Look up a contract</h3>
      <div className="search-row">
        <input
          placeholder="Contract ID (C...)"
          value={contractId}
          onChange={(e) => setContractId(e.target.value.trim())}
        />
      </div>
      <DateRangePicker start={range.start} end={range.end} onChange={setRange} />
      <p className="view-hint">
        Detailed event data is only available for roughly the last 6 days (public Soroban RPC
        retention). Older ranges automatically fall back to invocation transactions from Horizon.
      </p>

      {loading && <div className="chart-state">Loading…</div>}
      {error && <div className="chart-state error">{error}</div>}

      {data && (
        <>
          {/* A range can straddle the RPC retention window, so the API returns one
              segment per data source rather than forcing a single mode for the whole range. */}
          {(data.segments || []).map((seg) => (
            <div className="panel" key={seg.mode}>
              <div className="badge">{seg.mode === 'events' ? 'Decoded events (RPC)' : 'Fallback: invocations only (Horizon)'}</div>
              <p className="fidelity-note">{seg.fidelityNote}</p>
              {seg.truncated && (
                <div className="chart-note-banner">
                  Range is large — showing the first portion fetched. Narrow the range for a complete picture.
                </div>
              )}

              {seg.mode === 'events' ? (
                <ul className="tx-list">
                  {(seg.events || []).map((e) => (
                    <li key={e.id}>
                      <span>
                        Ledger {e.ledger} {e.inSuccessfulContractCall === false && '· failed call'}
                      </span>
                      <span>{new Date(e.ledgerClosedAt).toLocaleString()}</span>
                    </li>
                  ))}
                  {(seg.events || []).length === 0 && <li>No events in this segment.</li>}
                </ul>
              ) : (
                <ul className="tx-list">
                  {(seg.invocations || []).map((inv) => (
                    <li key={inv.transactionHash}>
                      <span>
                        {inv.transactionHash.slice(0, 10)}… · from {inv.sourceAccount?.slice(0, 6)}…
                      </span>
                      <span>{new Date(inv.createdAt).toLocaleString()}</span>
                    </li>
                  ))}
                  {(seg.invocations || []).length === 0 && <li>No invocations found in this segment.</li>}
                </ul>
              )}
            </div>
          ))}
          {(!data.segments || data.segments.length === 0) && <div className="chart-state">No data for this range.</div>}
        </>
      )}
    </div>
  );
}
