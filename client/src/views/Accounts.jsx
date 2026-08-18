import { useState } from 'react';
import { api } from '../api.js';
import { operationTypeLabel } from '../opTypes.js';
import { useAsyncResource } from '../hooks/useAsyncResource.js';

export default function Accounts({ network }) {
  const [input, setInput] = useState('');
  // enabled: false — manual, button-triggered lookup. [network] resetDeps still
  // clears a stale result (and drops an in-flight one) on network switch.
  const {
    data: account,
    error,
    loading,
    run: lookup,
  } = useAsyncResource((id) => api.account(network, id), [network], { enabled: false });

  return (
    <div className="view">
      <div className="search-row">
        <input
          placeholder="Paste a Stellar public key (G...)"
          value={input}
          onChange={(e) => setInput(e.target.value.trim())}
          onKeyDown={(e) => e.key === 'Enter' && input && lookup(input)}
        />
        <button className="btn-primary" onClick={() => input && lookup(input)}>
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
          <div className="table-wrap">
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
          </div>

          <h4 className="subhead-label">Recent Payments</h4>
          <ul className="tx-list">
            {account.recentPayments.map((p) => (
              <li key={p.id}>
                <span>
                  {p.to === account.id ? 'received from' : 'sent to'} {(p.to === account.id ? p.from : p.to)?.slice(0, 6)}…
                </span>
                <span>
                  {p.amount ? `${p.amount} ${p.assetCode || 'XLM'}` : operationTypeLabel(p.type)}
                  {p.assetIssuer && ` (${p.assetIssuer.slice(0, 6)}…)`} ·{' '}
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
