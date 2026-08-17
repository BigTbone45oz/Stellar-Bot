import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';

export default function ChartPanel({ title, loading, error, data, dataKey, xKey, kind = 'line', note, xAngle = 0 }) {
  const xAxisProps = xAngle
    ? { dataKey: xKey, stroke: '#565f80', fontSize: 11, angle: xAngle, textAnchor: 'end', height: 90, interval: 0 }
    : { dataKey: xKey, stroke: '#565f80', fontSize: 11 };

  return (
    <div className="chart-panel">
      <div className="chart-head">
        <h3>{title}</h3>
        {note && <span className="chart-note">{note}</span>}
      </div>
      {loading && <div className="chart-state">Loading…</div>}
      {!loading && error && <div className="chart-state error">{error}</div>}
      {!loading && !error && (!data || data.length === 0) && <div className="chart-state">No data for this range.</div>}
      {!loading && !error && data && data.length > 0 && (
        <ResponsiveContainer width="100%" height={240}>
          {kind === 'bar' ? (
            <BarChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#262d47" />
              <XAxis {...xAxisProps} />
              <YAxis stroke="#565f80" fontSize={11} />
              <Tooltip contentStyle={{ background: '#171d34', border: '1px solid #262d47' }} />
              <Bar dataKey={dataKey} fill="#4fd1c5" radius={[3, 3, 0, 0]} />
            </BarChart>
          ) : (
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#262d47" />
              <XAxis {...xAxisProps} />
              <YAxis stroke="#565f80" fontSize={11} />
              <Tooltip contentStyle={{ background: '#171d34', border: '1px solid #262d47' }} />
              <Line type="monotone" dataKey={dataKey} stroke="#e8b84b" strokeWidth={2} dot={false} />
            </LineChart>
          )}
        </ResponsiveContainer>
      )}
    </div>
  );
}
