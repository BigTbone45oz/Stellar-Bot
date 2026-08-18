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
      // A gateway timeout/outage can return an HTML or plain-text error body
      // (common for a proxy in front of an RPC node) — check res.ok before
      // parsing so that surfaces as a clean upstream error, not a raw
      // SyntaxError from res.json().
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
