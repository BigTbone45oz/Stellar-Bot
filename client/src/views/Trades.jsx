import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

export default function Trades({ network }) {
  const [code, setCode] = useState('');
  const [issuer, setIssuer] = useState('');
  const [trades, setTrades] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false); // distinguishes "never loaded" from "loaded, zero trades"

  // Same reasoning as Accounts.jsx: a manual lookup, no cleanup-based cancellation
  // available, so a network switch (or a second rapid click) mid-fetch could
  // otherwise let a stale response land after this state was already reset.
  const requestIdRef = useRef(0);

  // Same reasoning as Accounts.jsx — this is a manual lookup, not tied to a
  // fetch effect on `network`, so without this a previous network's trades
  // stayed on screen after switching, unlabeled as stale.
  useEffect(() => {
    requestIdRef.current += 1;
    setTrades([]);
    setError(null);
    setLoaded(false);
  }, [network]);

  async function load() {
    if (!code || !issuer) return;
    const myRequestId = ++requestIdRef.current;
    setLoading(true);
    try {
      const data = await api.recentTrades(network, code, issuer);
      if (requestIdRef.current !== myRequestId) return;
      setTrades(data);
      setError(null);
    } catch (e) {
      if (requestIdRef.current !== myRequestId) return;
      setError(e.message);
    } finally {
      // setLoaded(true) previously ran unconditionally here — a stale response
      // (e.g. from before a network switch) would still mark the *new* network's
      // search as "completed, found nothing" even though no request was ever
      // made against it, since only setTrades/setError/setLoading were guarded.
      if (requestIdRef.current === myRequestId) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }

  return (
    <div className="view">
      <p className="view-hint">
        For historical price/volume charts on a pair, use the Assets tab — it covers the same
        trade_aggregations data with a date range. This tab is for the live order flow.
      </p>
      <div className="search-row">
        <input placeholder="Asset code" value={code} onChange={(e) => setCode(e.target.value.trim().toUpperCase())} />
        <input placeholder="Issuer (G...)" value={issuer} onChange={(e) => setIssuer(e.target.value.trim())} />
        <button className="btn-primary" onClick={load}>
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
