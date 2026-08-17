import { useEffect, useState } from 'react';
import { api } from '../api.js';
import DateRangePicker from '../components/DateRangePicker.jsx';
import ChartPanel from '../components/ChartPanel.jsx';
import { defaultRange } from '../dateUtils.js';

// ledgers.js's parallel fetch is capped at 130,000 ledgers (~7.9 days of pubnet
// history) as a safety valve against runaway ranges — raised from an earlier, more
// conservative 50,000 (~2.9 days) specifically to fit a 7d preset. Offering 30d/90d
// presets here — even though DateRangePicker supports them elsewhere — would mean
// every click burns through several minutes of chunked Horizon requests (and real
// risk of hitting Horizon's public rate limit, since there's no retry/backoff for
// that yet) just to silently discard most of it past the cap. Restricting both the
// presets and the default to what this specific route can actually deliver without
// truncating or taking too long.
const LEDGER_RANGE_PRESETS = [
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '2d', hours: 48 },
  { label: '7d', hours: 168 },
];

export default function LedgersTransactions({ network }) {
  const [range, setRange] = useState(defaultRange(48));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .ledgerVolume(network, range.start, range.end)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [network, range.start, range.end]);

  return (
    <div className="view">
      <DateRangePicker start={range.start} end={range.end} onChange={setRange} presets={LEDGER_RANGE_PRESETS} />
      {data?.truncated && (
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
