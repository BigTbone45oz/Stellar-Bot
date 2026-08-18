import { useState } from 'react';
import { api } from '../api.js';
import DateRangePicker from '../components/DateRangePicker.jsx';
import ChartPanel from '../components/ChartPanel.jsx';
import { defaultRange } from '../dateUtils.js';
import { useAsyncResource } from '../hooks/useAsyncResource.js';

// ledgers.js's parallel fetch is capped at 130,000 ledgers (~7.9 days of pubnet
// history). Longer presets (30d/90d) would burn minutes of chunked Horizon
// requests just to be discarded past the cap, so presets/default are capped to
// what this route can actually deliver without truncating.
const LEDGER_RANGE_PRESETS = [
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '2d', hours: 48 },
  { label: '7d', hours: 168 },
];

export default function LedgersTransactions({ network }) {
  const [range, setRange] = useState(defaultRange(48));
  const { data, error, loading } = useAsyncResource(
    () => api.ledgerVolume(network, range.start, range.end),
    [network, range.start, range.end]
  );

  return (
    <div className="view">
      <DateRangePicker start={range.start} end={range.end} onChange={setRange} presets={LEDGER_RANGE_PRESETS} />
      {!loading && data?.truncated && (
        <div className="chart-note-banner">
          Range is large — showing the first portion fetched. Narrow the range for a complete picture.
        </div>
      )}
      <ChartPanel
        title="Transactions per day"
        loading={loading}
        error={error}
        data={data?.buckets}
        dataKey="transactions"
        xKey="date"
        kind="bar"
      />
      <ChartPanel
        title="Operations per day"
        loading={loading}
        error={error}
        data={data?.buckets}
        dataKey="operations"
        xKey="date"
        kind="line"
      />
    </div>
  );
}
