import { httpError } from './httpError.js';
import { DUNE_API_KEY } from './config.js';

// Fetches the latest cached result for a saved Dune query via
// GET /api/v1/query/{query_id}/results — does NOT trigger a fresh execution.
// That's a separate, credit-charged endpoint (POST .../execute) deliberately
// not used here, since these stats only need to be roughly current, not live.
const DUNE_RESULTS_URL = (queryId) => `https://api.dune.com/api/v1/query/${queryId}/results`;

export function duneConfigured(queryId) {
  return Boolean(DUNE_API_KEY && queryId);
}

// Shared "is this route even reachable" guard — every Dune-backed route is
// pubnet-only (Dune doesn't index testnet) and needs its own query ID
// configured. `envVarName` is the literal env var name for the error message,
// since it can't be recovered from `queryId`'s value once unset. Returns the
// { available: false, reason } payload to respond with immediately, or null
// if the route should proceed.
export function duneRouteUnavailable(net, queryId, envVarName, whatThisIs) {
  if (net.key !== 'pubnet') {
    return { available: false, reason: `${whatThisIs} is only meaningful on pubnet.` };
  }
  if (!duneConfigured(queryId)) {
    return { available: false, reason: `Dune isn't configured on the server (DUNE_API_KEY/${envVarName}).` };
  }
  return null;
}

export async function fetchDuneQueryResults(queryId, timeoutMs = 15_000) {
  if (!duneConfigured(queryId)) {
    throw httpError(501, 'Dune isn\'t configured — set DUNE_API_KEY and the relevant query ID in server/.env');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(DUNE_RESULTS_URL(queryId), {
      headers: { 'X-Dune-API-Key': DUNE_API_KEY, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw httpError(502, `Dune query lookup failed (${res.status}): ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    if (data.error) throw httpError(502, `Dune query error: ${data.error.message || data.error.type}`);
    // A query that's never been run (or is still executing) can return 200 with
    // no `result` field — `state`/`is_execution_finished` distinguish that from
    // a real zero-row result.
    if (data.is_execution_finished === false || (data.state && data.state !== 'QUERY_STATE_COMPLETED')) {
      throw httpError(502, `Dune query hasn't finished executing (state: ${data.state || 'unknown'}) — try again shortly`);
    }
    const rows = data.result?.rows || [];
    // `truncated` is attached directly to the rows array (not a new return
    // shape) so existing call sites keep working unchanged. NOTE: .map()/
    // .filter() return a new array and drop this property — read `.truncated`
    // off this original array, or destructure it before transforming.
    const totalRowCount = data.result?.metadata?.total_row_count;
    if (typeof totalRowCount === 'number' && totalRowCount > rows.length) {
      rows.truncated = true;
    }
    return rows;
  } catch (err) {
    if (err.name === 'AbortError') throw httpError(504, `Dune query lookup timed out after ${timeoutMs}ms`);
    if (err.status) throw err;
    throw httpError(502, `Dune query lookup failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}
