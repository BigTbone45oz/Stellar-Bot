import { httpError } from './httpError.js';
import { DUNE_API_KEY } from './config.js';

// Fetches the latest cached result for a saved Dune query — does NOT trigger a
// fresh execution (that's a separate, credit-heavier endpoint we deliberately
// don't use: this stat only needs to be roughly current, not live). Endpoint
// shape confirmed against Dune's own API docs (docs.dune.com/api-reference/
// executions/endpoint/get-query-result):
//   GET https://api.dune.com/api/v1/query/{query_id}/results
//   header: X-Dune-API-Key
//   response: { result: { rows: [...], metadata: {...} }, ... }
// One API key, multiple saved queries (see config.js) — every call here takes an
// explicit query ID rather than assuming a single global one.
const DUNE_RESULTS_URL = (queryId) => `https://api.dune.com/api/v1/query/${queryId}/results`;

export function duneConfigured(queryId) {
  return Boolean(DUNE_API_KEY && queryId);
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
    // Confirmed against Dune's docs: the response also carries `state`/
    // `is_execution_finished`, populated separately from `result`. A query that's
    // never been run (or is still executing) plausibly returns 200 with no `result`
    // field at all — previously `data.result?.rows || []` would silently treat that
    // as "zero rows" rather than surfacing that Dune hasn't actually produced an
    // answer yet, which the all-time/trend routes would then report to the user as
    // real zeros instead of "not ready".
    if (data.is_execution_finished === false || (data.state && data.state !== 'QUERY_STATE_COMPLETED')) {
      throw httpError(502, `Dune query hasn't finished executing (state: ${data.state || 'unknown'}) — try again shortly`);
    }
    return data.result?.rows || [];
  } catch (err) {
    if (err.name === 'AbortError') throw httpError(504, `Dune query lookup timed out after ${timeoutMs}ms`);
    if (err.status) throw err;
    throw httpError(502, `Dune query lookup failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}
