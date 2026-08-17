import { httpError } from './httpError.js';

export class SorobanRpcError extends Error {
  constructor(payload) {
    super(payload?.error?.message || 'Soroban RPC error');
    this.payload = payload;
    this.status = 502; // upstream (Soroban RPC) returned an error, not this server
  }
}

export function makeSorobanClient(rpcUrl, timeoutMs = 10_000) {
  let idCounter = 1;

  async function call(method, params = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: idCounter++, method, params }),
        signal: controller.signal,
      });
      // Unlike horizonClient.js, this previously went straight to res.json() with
      // no res.ok check — a gateway timeout/outage returning an HTML or plain-text
      // error body (a common failure mode for a proxy in front of an RPC node)
      // would throw a raw, unstructured SyntaxError from res.json() instead of a
      // clean upstream-error response.
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw httpError(502, `Soroban RPC request (${method}) failed (${res.status}): ${body.slice(0, 300)}`);
      }
      let payload;
      try {
        payload = await res.json();
      } catch {
        throw httpError(502, `Soroban RPC request (${method}) returned a non-JSON response`);
      }
      if (payload.error) throw new SorobanRpcError(payload);
      return payload.result;
    } catch (err) {
      if (err.name === 'AbortError') {
        throw httpError(504, `Soroban RPC request (${method}) timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getEvents: (params) => call('getEvents', params),
  };
}
