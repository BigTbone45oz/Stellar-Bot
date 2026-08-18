import { useState } from 'react';
import { api } from '../api.js';
import DateRangePicker from '../components/DateRangePicker.jsx';
import ChartPanel from '../components/ChartPanel.jsx';
import StatCard from '../components/StatCard.jsx';
import { defaultRange, OPS_BREAKDOWN_RANGE_PRESETS } from '../dateUtils.js';
import { useAsyncResource } from '../hooks/useAsyncResource.js';

export default function NetworkGrowth({ network }) {
  // All-time trend — backed by Dune (see server/src/routes/growth.js). Horizon
  // has no aggregate "operations by type per day" endpoint, so a real
  // multi-month trend can't come from live Horizon scanning the way the
  // "Recent activity" section below does — that approach hits a hard record
  // cap within hours on a busy network (verified live: even a 6h window can
  // exceed it), nowhere near enough for a meaningful trend.
  const {
    data: trend,
    error: trendError,
    loading: trendLoading,
  } = useAsyncResource(() => api.accountGrowthTrend(network), [network]);

  // Per-asset trustline growth — same Dune-backed reasoning as the account
  // trend above, just broken out by asset instead of network-wide.
  const {
    data: trustlines,
    error: trustlinesError,
    loading: trustlinesLoading,
  } = useAsyncResource(() => api.trustlineGrowthTrend(network), [network]);

  // Recent activity — live Horizon, same /api/payments/breakdown route
  // PaymentsOperations.jsx and SmartContracts.jsx already call. New-account/
  // trustline counts and the day-bucketed trend here are just additional
  // fields on that same response, not a separate fetch on their end. Bound by
  // the same op-density-based range cap as that page (see dateUtils.js's
  // OPS_BREAKDOWN_RANGE_PRESETS comment) — good for "right now," not for a
  // real historical trend, which is what the all-time section above is for.
  const [range, setRange] = useState(defaultRange(24));
  const {
    data: recent,
    error: recentError,
    loading: recentLoading,
  } = useAsyncResource(() => api.opsBreakdown(network, range.start, range.end), [network, range.start, range.end]);

  return (
    <div className="view">
      <h3 className="section-title">All-time trend</h3>
      <p className="view-hint">
        Account creation vs. account closure (account_merge), since Stellar's 2015 launch — the
        clearest long-range "is the network growing" signal, via Dune (live-Horizon scanning
        can't reach back this far without paging the network's entire history).
      </p>
      {trendLoading && <div className="chart-state">Loading…</div>}
      {trendError && <div className="chart-state error">{trendError}</div>}
      {!trendLoading && !trendError && trend && !trend.available && (
        <div className="chart-state">{trend.reason}</div>
      )}
      {!trendLoading && trend?.truncated && (
        <div className="chart-note-banner">
          Dune's result set for this query was larger than what came back — totals below may
          undercount.
        </div>
      )}
      {!trendLoading && trend?.available && (
        <>
          <div className="stat-row">
            <StatCard label="Accounts created, all time" value={trend.totalAccountsCreated.toLocaleString()} />
            <StatCard label="Accounts closed, all time" value={trend.totalAccountsMerged.toLocaleString()} />
            <StatCard label="Net account growth, all time" value={trend.netAccountGrowth.toLocaleString()} />
          </div>
          <ChartPanel
            title="Net new accounts per day, last 180 days"
            loading={false}
            error={null}
            data={trend.daily}
            dataKey="netGrowth"
            xKey="day"
            kind="line"
          />
        </>
      )}

      <h3 className="section-title">Trustline growth by asset, all time</h3>
      <p className="view-hint">
        Which specific assets are actually gaining/growing trustline activity — a network-wide
        total doesn't tell you if that's spread across the ecosystem or concentrated in a
        handful of assets. Same "establishing, adjusting, or removing" caveat as below applies
        here too — this counts trustline changes, not confirmed new trustlines.
      </p>
      {trustlinesLoading && <div className="chart-state">Loading…</div>}
      {trustlinesError && <div className="chart-state error">{trustlinesError}</div>}
      {!trustlinesLoading && !trustlinesError && trustlines && !trustlines.available && (
        <div className="chart-state">{trustlines.reason}</div>
      )}
      {!trustlinesLoading && trustlines?.truncated && (
        <div className="chart-note-banner">
          Dune's result set for this query was larger than what came back — totals below may
          undercount.
        </div>
      )}
      {!trustlinesLoading && trustlines?.available && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Asset</th>
                <th>Trustline changes, all time</th>
              </tr>
            </thead>
            <tbody>
              {trustlines.assetTotals.map((a, i) => (
                <tr key={`${a.code}-${a.issuer || 'native'}`}>
                  <td>{i + 1}</td>
                  <td>{a.code}</td>
                  <td>{a.changeCount.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="section-title">Recent activity</h3>
      <p className="view-hint">
        New accounts, account funding, and trustline activity, live from Horizon — real-time, but
        limited to a short range (see the trend above for the long-range picture).
      </p>
      <DateRangePicker start={range.start} end={range.end} onChange={setRange} presets={OPS_BREAKDOWN_RANGE_PRESETS} />
      {!recentLoading && recent?.truncated && (
        <div className="chart-note-banner">
          Range is large — showing the first portion fetched. Narrow the range for a complete picture.
        </div>
      )}

      <div className="stat-row">
        <StatCard label="New accounts" value={recent ? recent.newAccountCount.toLocaleString() : null} />
        <StatCard
          label="XLM used to fund new accounts"
          value={recent ? Number(recent.newAccountFundingXlm).toLocaleString(undefined, { maximumFractionDigits: 2 }) : null}
        />
        <StatCard label="Trustline changes" value={recent ? recent.newTrustlineCount.toLocaleString() : null} />
      </div>
      <p className="view-hint">
        "Trustline changes" covers establishing, adjusting, and removing a trustline — Horizon's
        operation record doesn't distinguish which, so this isn't only new trustlines.
      </p>

      <ChartPanel
        title="New accounts per day (this range)"
        loading={recentLoading}
        error={recentError}
        data={recent?.dailyGrowth}
        dataKey="newAccounts"
        xKey="day"
        kind="bar"
      />
      <ChartPanel
        title="Trustline changes per day (this range)"
        loading={recentLoading}
        error={recentError}
        data={recent?.dailyGrowth}
        dataKey="newTrustlines"
        xKey="day"
        kind="bar"
      />
    </div>
  );
}
