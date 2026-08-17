import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import DateRangePicker from '../components/DateRangePicker.jsx';
import ChartPanel from '../components/ChartPanel.jsx';
import { defaultRange, OPS_BREAKDOWN_RANGE_PRESETS } from '../dateUtils.js';
import { operationTypeLabel, operationTypeDescription } from '../opTypes.js';

export default function PaymentsOperations({ network }) {
  const [range, setRange] = useState(defaultRange(24));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Horizon's `type` is a snake_case API identifier (e.g. "path_payment_strict_send"),
  // not a display name — labeled with Stellar's own operation names instead. Keeping
  // `type` around in each row (rather than overwriting it) in case anything else ever
  // needs the raw identifier, e.g. a future click-through.
  const byTypeLabeled = useMemo(
    () => data?.byType.map((r) => ({ ...r, label: operationTypeLabel(r.type) })),
    [data]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .opsBreakdown(network, range.start, range.end)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [network, range.start, range.end]);

  return (
    <div className="view">
      <p className="view-hint">
        Operation counts are heavier to fetch than ledger summaries — default range is 24h; widen with care.
      </p>
      <DateRangePicker start={range.start} end={range.end} onChange={setRange} presets={OPS_BREAKDOWN_RANGE_PRESETS} />
      {data?.truncated && (
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

      {byTypeLabeled?.length > 0 && (
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
    </div>
  );
}
