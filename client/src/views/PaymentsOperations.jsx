import { useMemo, useState } from 'react';
import { api } from '../api.js';
import DateRangePicker from '../components/DateRangePicker.jsx';
import ChartPanel from '../components/ChartPanel.jsx';
import StatCard from '../components/StatCard.jsx';
import { defaultRange, OPS_BREAKDOWN_RANGE_PRESETS } from '../dateUtils.js';
import { operationTypeLabel, operationTypeDescription } from '../opTypes.js';
import { useAsyncResource } from '../hooks/useAsyncResource.js';

const TOP_PAYMENT_ASSETS_SHOWN = 10;

function formatAssetAmount(n) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatUsd(n) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export default function PaymentsOperations({ network }) {
  const [range, setRange] = useState(defaultRange(24));
  const { data, error, loading } = useAsyncResource(
    () => api.opsBreakdown(network, range.start, range.end),
    [network, range.start, range.end]
  );

  // Horizon's `type` is a snake_case API identifier (e.g. "path_payment_strict_send"),
  // not a display name — labeled with Stellar's own operation names instead. Keeping
  // `type` around in each row (rather than overwriting it) in case anything else ever
  // needs the raw identifier, e.g. a future click-through.
  const byTypeLabeled = useMemo(
    () => data?.byType.map((r) => ({ ...r, label: operationTypeLabel(r.type) })),
    [data]
  );

  return (
    <div className="view">
      <p className="view-hint">
        Operation counts are heavier to fetch than ledger summaries — default range is 24h; widen with care.
      </p>
      <DateRangePicker start={range.start} end={range.end} onChange={setRange} presets={OPS_BREAKDOWN_RANGE_PRESETS} />
      {!loading && data?.truncated && (
        <div className="chart-note-banner">
          Range is large — showing the first portion fetched. Narrow the range for a complete picture.
        </div>
      )}
      <ChartPanel
        title="Operations by type"
        loading={loading}
        error={error}
        data={byTypeLabeled}
        dataKey="count"
        xKey="label"
        kind="bar"
        xAngle={-40}
      />

      {!loading && byTypeLabeled?.length > 0 && (
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
              {byTypeLabeled.map((r) => (
                <tr key={r.type}>
                  <td>{r.label}</td>
                  <td>{r.count.toLocaleString()}</td>
                  <td>{operationTypeDescription(r.type)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="section-title">Network growth</h3>
      <p className="view-hint">
        New accounts funded and trustline activity in this range — real adoption signals,
        distinct from trading/payment volume below. "Trustline changes" covers establishing,
        adjusting, and removing a trustline — Horizon's operation record doesn't distinguish
        which, so this isn't only new trustlines.
      </p>
      <div className="stat-row">
        <StatCard label="New accounts" value={data ? data.newAccountCount.toLocaleString() : null} />
        <StatCard
          label="XLM used to fund new accounts"
          value={data ? Number(data.newAccountFundingXlm).toLocaleString(undefined, { maximumFractionDigits: 2 }) : null}
        />
        <StatCard label="Trustline changes" value={data ? data.newTrustlineCount.toLocaleString() : null} />
      </div>

      <h3 className="section-title">Payment volume</h3>
      <p className="view-hint">
        Value moved by plain payment operations (payment / path_payment_strict_send /
        path_payment_strict_receive) — not including new-account funding, tracked separately
        above. Stellar's original cross-border payment use case, separate from the
        trading/contract activity tracked on the Smart Contracts page.
      </p>
      {!loading && data && (
        <>
          <div className="stat-row">
            <StatCard label="Total payment volume (USD)" value={formatUsd(data.totalPaymentVolumeUsd)} />
            <StatCard
              label="Assets priced"
              value={`${data.pricedPaymentAssetCount} / ${data.paymentMovement.length}`}
            />
          </div>
          {data.pricedPaymentAssetCount < data.paymentMovement.length && (
            <p className="view-hint">
              {data.paymentMovement.length - data.pricedPaymentAssetCount} asset(s) had no resolvable
              USD price (still counted in the table below, just excluded from the USD total — so
              that total is a lower bound, not exact).
            </p>
          )}
          {data.paymentMovement.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Asset</th>
                    <th>Total moved</th>
                    <th>USD value</th>
                    <th># of payments</th>
                  </tr>
                </thead>
                <tbody>
                  {data.paymentMovement.slice(0, TOP_PAYMENT_ASSETS_SHOWN).map((a, i) => (
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
          )}
          {data.paymentMovement.length === 0 && (
            <div className="chart-state">No plain payment activity found in this range.</div>
          )}
        </>
      )}
    </div>
  );
}
