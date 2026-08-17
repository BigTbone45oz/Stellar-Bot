import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import StatCard from '../components/StatCard.jsx';

export default function Overview({ network }) {
  const [overview, setOverview] = useState(null);
  const [ledgers, setLedgers] = useState([]);
  const [error, setError] = useState(null);

  // Both the 30s interval and the visibilitychange handler can call load()
  // independently, so two calls can be in flight at once — without this, a
  // slow interval-triggered call finishing after a faster visibilitychange-
  // triggered one could overwrite fresher data with staler data. Same
  // request-generation pattern as the manual lookups in Accounts/Trades/Assets.
  const requestIdRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // Skip while the tab is hidden — no point polling Horizon for a chart
      // nobody's looking at. Refreshes immediately on visibilitychange below
      // instead, so data isn't stale when the user comes back.
      if (document.visibilityState === 'hidden') return;
      const myRequestId = ++requestIdRef.current;
      try {
        const [o, l] = await Promise.all([api.overview(network), api.recentLedgers(network, 10)]);
        if (!cancelled && requestIdRef.current === myRequestId) {
          setOverview(o);
          setLedgers(l);
          setError(null);
        }
      } catch (e) {
        if (!cancelled && requestIdRef.current === myRequestId) setError(e.message);
      }
    }
    load();
    const id = setInterval(load, 30_000);
    document.addEventListener('visibilitychange', load);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', load);
    };
  }, [network]);

  return (
    <div className="view">
      <div className="stat-row">
        <StatCard label="Latest Ledger" value={overview?.latestLedger?.toLocaleString()} />
        <StatCard label="Protocol" value={overview ? `v${overview.protocolVersion}` : null} />
        <StatCard
          label="Base Fee"
          value={overview ? `${(overview.baseFeeStroops / 1e7).toFixed(7)} XLM` : null}
        />
        <StatCard
          label="Base Reserve"
          value={overview ? `${(overview.baseReserveStroops / 1e7).toFixed(2)} XLM` : null}
        />
        <StatCard label="Horizon" value={overview?.horizonVersion} />
      </div>
      {error && <div className="chart-state error">{error}</div>}

      <h3 className="section-title">Recent Ledgers</h3>
      <div className="ledger-stream">
        {ledgers.map((l) => (
          <div className="star-node" key={l.sequence}>
            <div className="pip" />
            <div className="seq">#{l.sequence.toLocaleString()}</div>
            <div className="meta">{new Date(l.closedAt).toLocaleTimeString()}</div>
            <div className="txcount">
              {l.transactionCount} txs · {l.operationCount} ops
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
