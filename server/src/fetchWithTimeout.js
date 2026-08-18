import { httpError } from './httpError.js';

/**
 * Shared "fetch with an AbortController timeout" helper for third-party APIs
 * this app calls directly (StellarExpert, DeFiLlama, stellar.toml) —
 * horizonClient.js/sorobanClient.js have their own equivalent for their
 * upstreams. Two variants: best-effort lookups that degrade to null, and
 * routes that need a real upstream-error response.
 */

/** Best-effort GET: returns parsed JSON, or null on any failure (timeout, network error, non-2xx, bad JSON). */
export async function fetchJsonOrNull(url, { timeoutMs = 5000, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** GET that throws a clear httpError (504 on timeout, 502 otherwise) instead of a raw fetch/JSON error. */
export async function fetchJsonOrThrow(url, { timeoutMs = 10_000, headers, label } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw httpError(502, `${label} failed (${res.status})`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw httpError(504, `${label} timed out after ${timeoutMs}ms`);
    if (err.status) throw err;
    throw httpError(502, `${label} failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort GET returning raw text, or null on any failure — used for stellar.toml, not JSON. */
export async function fetchTextOrNull(url, { timeoutMs = 5000, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
