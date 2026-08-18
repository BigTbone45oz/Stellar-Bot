import { Fragment, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import DateRangePicker from '../components/DateRangePicker.jsx';
import ChartPanel from '../components/ChartPanel.jsx';
import { defaultRange } from '../dateUtils.js';
import { useAsyncResource } from '../hooks/useAsyncResource.js';

const PAGE_SIZE = 15;
const VOLUME_WINDOWS = [
  { value: '1h', label: '1h volume' },
  { value: '1d', label: '1d volume' },
  { value: '7d', label: '7d volume' },
  { value: '30d', label: '30d volume' },
];

// Plain-language summaries of StellarExpert's asset-rating methodology (each a 0-10
// sub-score rolling up into `average`) — not computed by this app, just explained here.
const RATING_INFO = {
  age: 'How long this asset has existed on the network — older, established assets score higher.',
  activity: 'Overall usage — combines the number of trades and payments made in this asset.',
  trustlines: 'How many accounts have opened a trustline for this asset.',
  liquidity: "Market depth — based on how much an asset's price slips when trading it against XLM.",
  volume7d: 'Trading volume over the last 7 days, on a logarithmic scale.',
  interop: 'Metadata & standards support — e.g. a published stellar.toml and SEP compliance.',
  average: 'The overall score — a simple average of the six indicators above; a rough popularity signal, not a quality judgment.',
};

function assetKey(a) {
  return `${a.code}-${a.issuer || 'native'}`;
}

// Key format the /details batch endpoint expects and echoes back as a result key.
// Must match exactly. Native XLM has no issuer — the server treats CODE:: (empty
// issuer) as native and prices it against a reference pair rather than leaving it blank.
function detailsKeyFor(a) {
  return `${a.code}:${a.issuer || ''}:${a.domain || ''}`;
}

// `details` is cached across page flips AND volume-window changes, but the server's
// response carries window-specific volume data. Namespacing the LOCAL cache key by
// volumeWindow (never sent to the server) keeps a stale window's volume from rendering
// under a newly selected window's label, and doubles as the "already fetched" check.
function localDetailsKey(a, volumeWindow) {
  return `${detailsKeyFor(a)}:${volumeWindow}`;
}

function formatUsd(n) {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumSignificantDigits: 6 });
}

function formatNum(n) {
  return n !== null && n !== undefined ? Number(n).toLocaleString() : '—';
}

export default function Assets({ network }) {
  const [code, setCode] = useState('');
  const [range, setRange] = useState(defaultRange(720)); // 30 days; trade_aggregations is
                                                            // server-aggregated, no truncation risk
  const [page, setPage] = useState(0);

  // Lazily fetched per visible page: display name, order-book depth, windowed volume.
  const [details, setDetails] = useState({});
  const [volumeWindow, setVolumeWindow] = useState('7d');

  // Shared between the top-100 table and code-search results — only one detail panel open at a time.
  const [expanded, setExpanded] = useState(null);
  const [openRatingDim, setOpenRatingDim] = useState(null);

  const {
    data: topAssetsData,
    error: topError,
    loading: topLoading,
  } = useAsyncResource(() => api.topAssets(network), [network], {
    // page/details/expanded/openRatingDim are plain UI state scoped to the top-100
    // table, reset here rather than via their own hooks. Search and price-history
    // state don't need this — each has `network` in its own resetDeps already.
    onReset: () => {
      setPage(0);
      setDetails({});
      setExpanded(null);
      setOpenRatingDim(null);
    },
  });
  const topAssets = topAssetsData || [];

  const pageCount = Math.max(1, Math.ceil(topAssets.length / PAGE_SIZE));
  const pageAssets = useMemo(
    () => topAssets.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE),
    [topAssets, page]
  );

  // Fetches details only for the 15 on-screen assets, not all 100. Not a
  // useAsyncResource: this MERGES into existing `details` rather than replacing it,
  // and swallows errors best-effort with no loading/error state of its own.
  useEffect(() => {
    if (pageAssets.length === 0) return;
    // Skip if every asset on this page already has a details entry for the current
    // volume window, so revisiting a seen page+window doesn't re-hit the network.
    const needsFetch = pageAssets.some((a) => !(localDetailsKey(a, volumeWindow) in details));
    if (!needsFetch) return;
    let cancelled = false;
    const assetsParam = pageAssets.map(detailsKeyFor).join(',');
    api
      .assetDetails(network, assetsParam, volumeWindow)
      .then((d) => {
        if (cancelled) return;
        setDetails((prev) => {
          const next = { ...prev };
          for (const a of pageAssets) {
            const serverKey = detailsKeyFor(a);
            if (serverKey in d) next[localDetailsKey(a, volumeWindow)] = d[serverKey];
          }
          return next;
        });
      })
      .catch(() => {}); // best-effort enrichment — table still works with just /top's data
    return () => {
      cancelled = true;
    };
  }, [network, pageAssets, volumeWindow, details]);

  // Manual search — enabled: false; `network` still in resetDeps to clear stale results.
  const {
    data: searchResults,
    error: searchError,
    run: runSearch,
  } = useAsyncResource((c) => api.assetSearch(network, c), [network], { enabled: false });
  const results = searchResults || [];
  // "Searched, found nothing" vs. "never searched": both start null, only one
  // becomes non-null once a search resolves.
  const searched = searchResults !== null || searchError !== null;

  function search() {
    if (code) runSearch(code);
  }

  // Price/volume history for the expanded asset (native XLM has no issuer to chart
  // against itself — see the native branch in renderDetail). On a network switch,
  // this effect's resetDeps and the topAssets hook's onReset (which clears
  // `expanded`) fire in the same commit, so this can still see the OLD `expanded`
  // alongside the NEW `network` for one render. `expandedForNetwork` (set in
  // toggleExpand) guards against firing a request for that stale pairing.
  const {
    data: historyData,
    error,
    loading,
  } = useAsyncResource(
    () => api.priceHistory(network, expanded.code, expanded.issuer, range.start, range.end),
    [network, expanded, range.start, range.end],
    { enabled: Boolean(expanded) && !expanded.native && expanded?.expandedForNetwork === network }
  );
  const history = historyData?.records ?? null;
  const historyTruncated = historyData?.truncated ?? false;

  // Computed once, reused by both charts below.
  const chartData = useMemo(
    () => history?.map((h) => ({ ...h, date: new Date(h.timestamp).toISOString().slice(0, 10) })),
    [history]
  );

  function toggleExpand(asset) {
    setOpenRatingDim(null);
    // Tagged with the network it was expanded under — see the price-history hook above.
    setExpanded((prev) => (prev && assetKey(prev) === assetKey(asset) ? null : { ...asset, expandedForNetwork: network }));
  }

  function goToPage(next) {
    setExpanded(null);
    setOpenRatingDim(null);
    setPage(next);
  }

  function renderDetail(a) {
    const d = details[localDetailsKey(a, volumeWindow)];
    const liquidityUsd = d?.liquidity != null && a.priceUsd != null ? d.liquidity * a.priceUsd : null;
    const volumeUsd = d?.volume != null && a.priceUsd != null ? d.volume * a.priceUsd : null;

    return (
      <tr className="asset-detail-row">
        <td colSpan={9}>
          <div className="asset-detail">
            <div className="asset-detail-grid">
              <div>
                <span className="subhead-label">Issuer</span>
                <div className={a.issuer ? 'account-id' : ''}>{a.issuer || 'native asset — no issuer'}</div>
              </div>
              <div>
                <span className="subhead-label">Domain / org</span>
                <div>{a.domain || a.orgName || '—'}</div>
              </div>
              <div>
                <span className="subhead-label">Created</span>
                <div>{a.createdAt ? new Date(a.createdAt).toLocaleDateString() : '—'}</div>
              </div>
              <div>
                <span className="subhead-label">Supply</span>
                <div>{formatNum(a.supply)}</div>
              </div>
              <div>
                <span className="subhead-label">Price</span>
                <div>{formatUsd(a.priceUsd)}</div>
              </div>
              <div>
                <span className="subhead-label">Market cap</span>
                <div>{formatUsd(a.marketCapUsd)}</div>
              </div>
              <div>
                <span className="subhead-label">{VOLUME_WINDOWS.find((w) => w.value === volumeWindow).label}</span>
                <div>{d ? formatUsd(volumeUsd) : 'loading…'}</div>
              </div>
              <div>
                <span className="subhead-label">Liquidity (order book depth)</span>
                <div>{d ? formatUsd(liquidityUsd) : 'loading…'}</div>
              </div>
              <div>
                <span className="subhead-label">Holders</span>
                <div>{formatNum(a.holders)}</div>
              </div>
            </div>

            {a.rating && (
              <>
                <span className="subhead-label">StellarExpert rating (click any for an explanation)</span>
                <div className="rating-row">
                  {Object.entries(a.rating).map(([k, v]) => (
                    <button
                      key={k}
                      type="button"
                      className={`badge badge-btn${openRatingDim === k ? ' active' : ''}`}
                      onClick={() => setOpenRatingDim((prev) => (prev === k ? null : k))}
                    >
                      {k} {v}
                    </button>
                  ))}
                </div>
                {openRatingDim && a.rating[openRatingDim] !== undefined && (
                  <p className="view-hint">
                    <strong>{openRatingDim}:</strong> {RATING_INFO[openRatingDim]}
                  </p>
                )}
              </>
            )}

            {a.native ? (
              <p className="view-hint">See the Trades tab for XLM/asset price and volume history.</p>
            ) : (
              <>
                <span className="subhead-label">Price &amp; volume history</span>
                <DateRangePicker start={range.start} end={range.end} onChange={setRange} />
                {!loading && historyTruncated && (
                  <div className="chart-note-banner">
                    Range is large — showing the first portion fetched. Narrow the range or use a
                    coarser resolution for a complete picture.
                  </div>
                )}
                <ChartPanel
                  title="Average price (XLM)"
                  loading={loading}
                  error={error}
                  data={chartData}
                  dataKey="avgPrice"
                  xKey="date"
                  kind="line"
                />
                <ChartPanel
                  title="Trade count"
                  loading={loading}
                  error={error}
                  data={chartData}
                  dataKey="tradeCount"
                  xKey="date"
                  kind="bar"
                />
              </>
            )}
          </div>
        </td>
      </tr>
    );
  }

  return (
    <div className="view">
      <h3 className="section-title">Top 100 assets</h3>
      <p className="view-hint">
        Ranked by StellarExpert's composite rating (age, activity, trustlines, liquidity,
        7-day volume, interop) — Horizon has no ranking of its own to sort by. Click a row
        for full detail. Volume figures come from Horizon's own trade data (not
        StellarExpert's, which turned out to be scoped differently), summed from buckets
        finer than the window itself so a "1h"/"1d" reading doesn't land entirely inside
        Horizon's still-forming current bucket — a partial bucket at either edge of the
        window can still be missed, so treat these as close, not to-the-second exact.
      </p>

      {topLoading && <div className="chart-state">Loading top assets…</div>}
      {topError && <div className="chart-state error">{topError}</div>}

      {!topLoading && pageAssets.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="assets-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Name</th>
                  <th>Code</th>
                  <th></th>
                  <th>Price</th>
                  <th>
                    <select
                      className="window-select"
                      value={volumeWindow}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setVolumeWindow(e.target.value)}
                    >
                      {VOLUME_WINDOWS.map((w) => (
                        <option key={w.value} value={w.value}>
                          {w.label}
                        </option>
                      ))}
                    </select>
                  </th>
                  <th>Market cap</th>
                  <th>Liquidity</th>
                  <th>Holders</th>
                </tr>
              </thead>
              <tbody>
                {pageAssets.map((a) => {
                  const isOpen = expanded && assetKey(expanded) === assetKey(a);
                  const d = details[localDetailsKey(a, volumeWindow)];
                  const displayName = d?.name || a.name;
                  const liquidityUsd = d?.liquidity != null && a.priceUsd != null ? d.liquidity * a.priceUsd : null;
                  const volumeUsd = d?.volume != null && a.priceUsd != null ? d.volume * a.priceUsd : null;
                  return (
                    <Fragment key={assetKey(a)}>
                      <tr
                        className={`asset-row${isOpen ? ' open' : ''}`}
                        onClick={() => toggleExpand(a)}
                      >
                        <td>{a.rank}</td>
                        <td>{displayName}</td>
                        <td>{a.code}</td>
                        <td></td>
                        <td>{formatUsd(a.priceUsd)}</td>
                        <td>{d ? formatUsd(volumeUsd) : '…'}</td>
                        <td>{formatUsd(a.marketCapUsd)}</td>
                        <td>{d ? formatUsd(liquidityUsd) : '…'}</td>
                        <td>{formatNum(a.holders)}</td>
                      </tr>
                      {isOpen && renderDetail(a)}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="pagination">
            <button className="btn-ghost" disabled={page === 0} onClick={() => goToPage(page - 1)}>
              Previous
            </button>
            <span className="view-hint">
              Page {page + 1} of {pageCount}
            </span>
            <button className="btn-ghost" disabled={page >= pageCount - 1} onClick={() => goToPage(page + 1)}>
              Next
            </button>
          </div>
        </>
      )}

      <h3 className="section-title">Search by code</h3>
      <div className="search-row">
        <input
          placeholder="Asset code, e.g. USDC"
          value={code}
          onChange={(e) => setCode(e.target.value.trim().toUpperCase())}
          onKeyDown={(e) => e.key === 'Enter' && search()}
        />
        <button className="btn-primary" onClick={search}>
          Search
        </button>
      </div>

      {searchError && <div className="chart-state error">{searchError}</div>}

      {!searchError && searched && results.length === 0 && (
        <div className="chart-state">No assets found for that code.</div>
      )}

      {results.length > 0 && (
        <ul className="tx-list">
          {results.map((a) => (
            <li key={a.issuer}>
              <span>
                {a.code} · issuer {a.issuer.slice(0, 6)}… · {Number(a.numAccounts).toLocaleString()} trustlines
              </span>
              <button className="btn-ghost" onClick={() => toggleExpand({ ...a, native: false })}>
                View history
              </button>
            </li>
          ))}
        </ul>
      )}

      {expanded && !pageAssets.some((a) => assetKey(a) === assetKey(expanded)) && (
        <>
          <h3 className="section-title">{expanded.code} / XLM — price &amp; volume</h3>
          <DateRangePicker start={range.start} end={range.end} onChange={setRange} />
          {!loading && historyTruncated && (
            <div className="chart-note-banner">
              Range is large — showing the first portion fetched. Narrow the range or use a
              coarser resolution for a complete picture.
            </div>
          )}
          <ChartPanel
            title="Average price (XLM)"
            loading={loading}
            error={error}
            data={chartData}
            dataKey="avgPrice"
            xKey="date"
            kind="line"
          />
          <ChartPanel
            title="Trade count"
            loading={loading}
            error={error}
            data={chartData}
            dataKey="tradeCount"
            xKey="date"
            kind="bar"
          />
        </>
      )}
    </div>
  );
}
