import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { operationTypeLabel } from '../opTypes.js';

export default function Accounts({ network }) {
  const [input, setInput] = useState('');
  const [account, setAccount] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  // Manual lookups have no `cancelled`-on-cleanup guard the way automatic fetch
  // effects elsewhere in this app do, since there's no effect to clean up — a
  // click, not a dependency change, triggers the fetch. Without this counter, a
  // network switch mid-lookup could let the old-network response land after the
  // reset effect below already cleared state (the reset only helps for a
  // response that had already arrived, not one still in flight), and two rapid
  // lookups could resolve out of order with the older one overwriting the newer.
  const requestIdRef = useRef(0);

  // No fetch is tied to `network` here (lookup is manual, by account id) — but
  // without this, an account looked up on one network stayed on screen after
  // switching networks, with nothing indicating it was fetched from the network
  // no longer selected. Clear rather than silently leave stale/wrong-network data.
  useEffect(() => {
    requestIdRef.current += 1; // invalidate any in-flight lookup from before the switch
    setAccount(null);
    setError(null);
  }, [network]);

  async function lookup(id) {
    if (!id) return;
    const myRequestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await api.account(network, id);
      if (requestIdRef.current !== myRequestId) return; // superseded — don't apply a stale result
      setAccount(data);
    } catch (e) {
      if (requestIdRef.current !== myRequestId) return;
      setError(e.message);
      setAccount(null);
    } finally {
      if (requestIdRef.current === myRequestId) setLoading(false);
    }
  }

  return (
    <div className="view">
      <div className="search-row">
        <input
          placeholder="Paste a Stellar public key (G...)"
          value={input}
          onChange={(e) => setInput(e.target.value.trim())}
          onKeyDown={(e) => e.key === 'Enter' && lookup(input)}
        />
        <button className="btn-primary" onClick={() => lookup(input)}>
          Look up
        </button>
      </div>

      {loading && <div className="chart-state">Loading…</div>}
      {error && <div className="chart-state error">{error}</div>}

      {account && (
        <div className="panel">
          <div className="account-id">{account.id}</div>
          <div className="account-sub">
            Sequence {account.sequence} · {account.subentryCount} subentries
          </div>

          <h4 className="subhead-label">Balances</h4>
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Balance</th>
              </tr>
            </thead>
            <tbody>
              {account.balances.map((b) => (
                <tr key={`${b.asset_type}-${b.asset_code || 'native'}-${b.asset_issuer || ''}`}>
                  <td>{b.asset_type === 'native' ? 'XLM' : b.asset_code}</td>
                  <td>{Number(b.balance).toLocaleString(undefined, { maximumFractionDigits: 7 })}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4 className="subhead-label">Recent Payments</h4>
          <ul className="tx-list">
            {account.recentPayments.map((p) => (
              <li key={p.id}>
                <span>
                  {p.to === account.id ? 'received from' : 'sent to'} {(p.to === account.id ? p.from : p.to)?.slice(0, 6)}…
                </span>
                <span>
                  {p.amount ? `${p.amount} ${p.assetCode || 'XLM'}` : operationTypeLabel(p.type)} ·{' '}
                  {new Date(p.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
