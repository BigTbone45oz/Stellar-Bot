import { httpError } from './httpError.js';

export class HorizonError extends Error {
  constructor(status, body) {
    super(`Horizon request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

export function makeHorizonClient(baseUrl, timeoutMs = 10_000) {
  async function get(path, params = {}) {
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new HorizonError(res.status, body);
      }
      try {
        return await res.json();
      } catch {
        // A 2xx response with a non-JSON body (e.g. a proxy/CDN error or
        // challenge page under a 200) would otherwise surface as a raw
        // SyntaxError instead of a clean upstream-error response.
        throw httpError(502, `Horizon returned a non-JSON response for ${url.pathname}`);
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        throw httpError(504, `Horizon request to ${url.pathname} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  return { get, baseUrl };
}
