import { useState } from 'react';
import { api } from '../api.js';
import { useAsyncResource } from '../hooks/useAsyncResource.js';

export default function Trades({ network }) {
  const [code, setCode] = useState('');
  const [issuer, setIssuer] = useState('');
  // Manual, button-triggered lookup.
  const {
    data,
    error,
    loading,
    run: load,
  } = useAsyncResource((c, iss) => api.recentTrades(network, c, iss), [network], { enabled: false });

  const trades = data || [];
  // data/error are both null until the first request resolves, so this doubles
  // as "has a request completed" without a separate boolean.
  const loaded = data !== null || error !== null;

  return (
    <div className="view">
      <p className="view-hint">
        For historical price/volume charts on a pair, use the Assets tab — it covers the same
        trade_aggregations data with a date range. This tab is for the live order flow.
      </p>
      <div className="search-row">
        <input placeholder="Asset code" value={code} onChange={(e) => setCode(e.target.value.trim().toUpperCase())} />
        <input placeholder="Issuer (G...)" value={issuer} onChange={(e) => setIssuer(e.target.value.trim())} />
        <button className="btn-primary" onClick={() => code && issuer && load(code, issuer)}>
          Load trades
        </button>
      </div>

      {loading && <div className="chart-state">Loading…</div>}
      {error && <div className="chart-state error">{error}</div>}
      {!loading && !error && loaded && trades.length === 0 && (
        <div className="chart-state">No recent trades for this pair.</div>
      )}

      <ul className="tx-list">
        {trades.map((t) => (
          <li key={t.id}>
            <span>{new Date(t.ledgerCloseTime).toLocaleString()}</span>
            <span>
              {t.baseAmount} XLM for {t.counterAmount} {code}
              {t.price !== null && ` (${t.price.toFixed(7)} ${code}/XLM)`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
