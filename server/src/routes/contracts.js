import { Router } from 'express';
import { TransactionBuilder, Networks, Address, StrKey } from '@stellar/stellar-sdk';
import { resolveNetwork, DUNE_QUERY_ID, DUNE_SOROSWAP_TREND_QUERY_ID, DUNE_SOROSWAP_FUNCTIONS_QUERY_ID } from '../config.js';
import { makeHorizonClient } from '../horizonClient.js';
import { makeSorobanClient } from '../sorobanClient.js';
import { ledgerSequenceForTimestamp, STELLAR_EXPERT_NETWORK } from '../ledgerTime.js';
import { cached, TTL, ttlForRange } from '../cache.js';
import { fetchRangeParallel } from '../rangeFetch.js';
import { parseDateRange } from '../validate.js';
import { fetchAssetUsdPrice } from '../assetPricing.js';
import { duneConfigured, fetchDuneQueryResults } from '../duneClient.js';

const router = Router();
const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/;

// Public Soroban RPC nodes only retain ~7 days of event history. We use 6 days
// as a safety margin. Anything older falls back to Horizon's invoke_host_function
// operations (real history, but no decoded event data). If the requested range
// straddles the boundary, we fetch both and merge, labeling each segment.
const RETENTION_DAYS = 6;

const TOP_ALL_TIME_ASSETS_SHOWN = 10;

function passphraseFor(networkKey) {
  return networkKey === 'testnet' ? Networks.TESTNET : Networks.PUBLIC;
}

// All-time (since Soroban's mainnet launch) total value moved through contract
// calls — unlike /:id/activity and payments.js's /breakdown, this can't come from
// live Horizon/RPC scanning (would mean paging ~13.5M ledgers ourselves). Backed
// instead by a saved Dune query (see server/.env's DUNE_QUERY_ID, and the README)
// against Dune's pre-indexed `stellar.history_operations`/`stellar.history_effects`
// tables, which already cover full history. Pubnet-only — Dune doesn't index
// testnet, and an all-time total wouldn't mean much there anyway (SDF periodically
// resets testnet, see CLAUDE.md).
router.get('/all-time', async (req, res, next) => {
  try {
    const net = resolveNetwork(req.query.network);
    if (net.key !== 'pubnet') {
      return res.json({ available: false, reason: 'All-time totals are only meaningful on pubnet.' });
    }
    if (!duneConfigured(DUNE_QUERY_ID)) {
      return res.json({ available: false, reason: 'Dune isn\'t configured on the server (DUNE_API_KEY/DUNE_QUERY_ID).' });
    }

    // Dune's own materialized result barely changes minute-to-minute (it only
    // refreshes when the saved query is re-run), so this is cached generously —
    // no reason to spend a Dune API credit on every page load.
    const data = await cached('contractsAllTime:pubnet', TTL.FINALIZED, async () => {
      const rows = await fetchDuneQueryResults(DUNE_QUERY_ID);

      const assets = rows
        .map((r) => ({
          code: r.asset_code || 'XLM',
          issuer: r.asset_issuer || null,
          totalAmount: Number(r.total_amount) || 0,
          effectCount: Number(r.effect_count) || 0,
        }))
        .filter((a) => a.totalAmount > 0);

      const expertNetwork = STELLAR_EXPERT_NETWORK.pubnet;
      const CONCURRENCY = 6;
      let nextIdx = 0;
      async function priceWorker() {
        while (nextIdx < assets.length) {
          const entry = assets[nextIdx++];
          entry.priceUsd = await cached(
            `assetPriceUsd:pubnet:${entry.code}:${entry.issuer || 'native'}`,
            TTL.RECENT,
            () => fetchAssetUsdPrice(expertNetwork, entry.code, entry.issuer)
          ).catch(() => null);
          entry.totalUsd = entry.priceUsd !== null ? entry.totalAmount * entry.priceUsd : null;
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, assets.length) || 1 }, priceWorker));

      assets.sort((a, b) => {
        if (a.totalUsd !== null && b.totalUsd !== null) return b.totalUsd - a.totalUsd;
        if (a.totalUsd !== null) return -1;
        if (b.totalUsd !== null) return 1;
        return b.totalAmount - a.totalAmount;
      });

      const totalMovedUsd = assets.reduce((sum, a) => sum + (a.totalUsd || 0), 0);
      const pricedAssetCount = assets.filter((a) => a.totalUsd !== null).length;

      return {
        available: true,
        totalMovedUsd,
        pricedAssetCount,
        assetCount: assets.length,
        topAssets: assets.slice(0, TOP_ALL_TIME_ASSETS_SHOWN),
      };
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Day-bucketed call-volume trend for a specific, confirmed-Soroban protocol —
// "how often is this actually being used, and is that growing" over time, since
// launch — plus, now, a real per-function breakdown ("what are they actually
// calling it to do", not just "a call happened"), both since Soroswap's launch.
// Currently Soroswap only (contract addresses verified against its own GitHub
// docs, filtered in the Dune queries themselves, not here). Deliberately NOT
// extended to other DeFiLlama-listed Stellar "DEX" protocols yet — several of
// them (Aquarius, LumenSwap, Scopuly) predate Soroban and run mostly or entirely
// on Stellar's classic protocol-level DEX/liquidity pools, not smart contracts;
// mixing that in would misrepresent this as "Soroban usage" when much of it isn't.
//
// The function-name breakdown comes from a second, separate Dune query against
// `parameters_decoded` — Dune decodes each invoke_host_function op's parameters
// as a ROW("type" varchar, "value" varchar) array; index 2's `.value` is the
// invoked function's Symbol, per InvokeContractArgs' fixed struct field order
// (contractAddress, functionName, args) — same fact this codebase's own
// decodeInvokedFunctionName (payments.js) already relies on for raw XDR, just
// decoded by Dune instead of by us. Verified live: real function names came
// back (swap_exact_tokens_for_tokens, add_liquidity, remove_liquidity, ...),
// not placeholders.
router.get('/protocol-trend', async (req, res, next) => {
  try {
    const net = resolveNetwork(req.query.network);
    if (net.key !== 'pubnet') {
      return res.json({ available: false, reason: 'Protocol trends are pubnet-only.' });
    }
    if (!duneConfigured(DUNE_SOROSWAP_TREND_QUERY_ID)) {
      return res.json({ available: false, reason: 'Dune isn\'t configured on the server (DUNE_API_KEY/DUNE_SOROSWAP_TREND_QUERY_ID).' });
    }

    const data = await cached('contractsProtocolTrend:soroswap:pubnet:v2', TTL.FINALIZED, async () => {
      const rows = await fetchDuneQueryResults(DUNE_SOROSWAP_TREND_QUERY_ID);

      const byDay = new Map();
      for (const r of rows) {
        const entry = byDay.get(r.day) || { day: r.day, invokeCount: 0, createCount: 0 };
        if (r.function === 'HostFunctionTypeHostFunctionTypeInvokeContract') entry.invokeCount += Number(r.call_count) || 0;
        if (r.function === 'HostFunctionTypeHostFunctionTypeCreateContract') entry.createCount += Number(r.call_count) || 0;
        byDay.set(r.day, entry);
      }

      const daily = Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? -1 : 1));

      // Function-name breakdown is optional — the call-volume trend above still
      // works even if this second query isn't configured, it just won't have a
      // "what for" answer to go with the "how often" one.
      let functionTotals = [];
      let dailyByFunction = {};
      if (duneConfigured(DUNE_SOROSWAP_FUNCTIONS_QUERY_ID)) {
        const fnRows = await fetchDuneQueryResults(DUNE_SOROSWAP_FUNCTIONS_QUERY_ID);
        const totals = new Map();
        for (const r of fnRows) {
          const name = r.function_name || 'unknown';
          const count = Number(r.call_count) || 0;
          totals.set(name, (totals.get(name) || 0) + count);
          (dailyByFunction[name] ||= []).push({ day: r.day, callCount: count });
        }
        functionTotals = Array.from(totals.entries())
          .map(([name, callCount]) => ({ name, callCount }))
          .sort((a, b) => b.callCount - a.callCount);
      }

      return {
        available: true,
        protocol: 'Soroswap',
        totalInvokeCalls: daily.reduce((sum, d) => sum + d.invokeCount, 0),
        totalPoolsCreated: daily.reduce((sum, d) => sum + d.createCount, 0),
        daily,
        functionTotals,
        dailyByFunction,
      };
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/activity', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!CONTRACT_ID_RE.test(id)) {
      return res.status(400).json({ error: 'Not a valid contract id (should start with C)' });
    }
    const { start, end, startMs, endMs } = parseDateRange(req.query);
    const net = resolveNetwork(req.query.network);
    const horizon = makeHorizonClient(net.horizon);
    const retentionCutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

    const cacheKey = `contractActivity:${net.key}:${id}:${start}:${end}`;
    const data = await cached(cacheKey, ttlForRange(endMs), async () => {
      const segments = [];

      if (endMs >= retentionCutoffMs) {
        // Portion of the range that's within RPC retention.
        const eventsStart = Math.max(startMs, retentionCutoffMs);
        segments.push(await fetchViaRpcEvents(net, horizon, id, eventsStart, endMs));
      }
      if (startMs < retentionCutoffMs) {
        // Portion of the range older than retention.
        const fallbackEnd = new Date(Math.min(endMs, retentionCutoffMs)).toISOString();
        segments.push(await fetchViaHorizonFallback(horizon, net.key, id, start, fallbackEnd, passphraseFor(net.key)));
      }

      return { segments };
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

async function fetchViaRpcEvents(net, horizon, contractId, startMs, endMs) {
  const soroban = makeSorobanClient(net.sorobanRpc);

  const events = [];
  const MAX_EVENTS = 500;
  let cursor;
  let truncated = false;

  // getEvents has no end-time param — page forward with the response cursor
  // until we pass endMs or hit the cap, rather than trusting a single page.
  //
  // RETENTION_DAYS (6) is a documented safety margin under Soroban RPC's
  // approximate "~7 days" retention, not a guarantee — a real public node can
  // still reject `startLedger` as outside its actual retained range (verified
  // live against mainnet.sorobanrpc.com: a too-old startLedger returns a
  // SorobanRpcError, "startLedger must be within the ledger range: ..."). Every
  // other best-effort external call in this file/codebase degrades gracefully
  // rather than failing the whole request — this one didn't, so a boundary case
  // took down the entire /:id/activity response (including the unrelated
  // Horizon-fallback segment) instead of just this segment.
  //
  // The ledgerSequenceForTimestamp call is INSIDE this try too (a first attempt
  // at this fix left it outside, which meant a transient Horizon failure while
  // resolving the start ledger — the exact class of error this fix exists to
  // handle — could still take down the whole /:id/activity response).
  try {
    const ledger = await ledgerSequenceForTimestamp(horizon, net.key, new Date(startMs).toISOString());
    while (events.length < MAX_EVENTS) {
      const params = {
        filters: [{ type: 'contract', contractIds: [contractId] }],
        limit: 100,
        ...(cursor ? { pagination: { cursor } } : { startLedger: ledger }),
      };
      const result = await soroban.getEvents(params);
      const batch = result.events || [];
      if (batch.length === 0) break;

      let hitEnd = false;
      for (const e of batch) {
        if (new Date(e.ledgerClosedAt).getTime() > endMs) {
          hitEnd = true;
          break;
        }
        events.push(e);
        // Checked per-event, not just once per 100-event batch — otherwise a
        // batch straddling the cap could push events.length well past
        // MAX_EVENTS (up to +99) before the post-loop check below ever fired.
        if (events.length >= MAX_EVENTS) {
          truncated = true;
          break;
        }
      }
      if (hitEnd || truncated) break;
      if (batch.length < 100) break;
      cursor = batch[batch.length - 1].id;
    }
  } catch (err) {
    return {
      mode: 'events',
      fidelityNote: `Decoded contract events unavailable for this range: ${err.message}`,
      truncated: false,
      events: [],
    };
  }

  return {
    mode: 'events',
    fidelityNote: 'Decoded contract events from Soroban RPC.',
    truncated,
    events: events.map((e) => ({
      id: e.id,
      ledger: e.ledger,
      ledgerClosedAt: e.ledgerClosedAt,
      topic: e.topic,
      value: e.value,
      inSuccessfulContractCall: e.inSuccessfulContractCall,
    })),
  };
}

async function fetchViaHorizonFallback(horizon, networkKey, contractId, start, end, passphrase) {
  const [startSeq, endSeq] = await Promise.all([
    ledgerSequenceForTimestamp(horizon, networkKey, start),
    ledgerSequenceForTimestamp(horizon, networkKey, end),
  ]);

  const candidates = [];
  const { truncated } = await fetchRangeParallel(horizon, '/operations', startSeq, endSeq, {
    ledgersPerChunk: 20, // see payments.js for why: op density per ledger varies
    maxRecords: 10_000,
    onPage: (records) => {
      for (const op of records) {
        if (op.type === 'invoke_host_function') candidates.push(op);
      }
    },
  });

  // Horizon's JSON for invoke_host_function ops doesn't expose the invoked
  // contract's address as plain text — it's only recoverable from the
  // transaction's raw XDR. Decode each candidate transaction and check its
  // operations properly, rather than string-matching against encoded bytes
  // (which can never match — that was the bug in the previous version).
  //
  // Fetching each unique transaction's envelope is independent work, so it
  // runs with bounded concurrency rather than one-at-a-time — same rationale
  // as fetchRangeParallel above, just for a different shape of fetch.
  const uniqueHashes = Array.from(new Set(candidates.map((op) => op.transaction_hash)));
  const matchedHashes = new Set();
  const CONCURRENCY = 6;
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < uniqueHashes.length) {
      const hash = uniqueHashes[nextIdx++];
      const tx = await horizon.get(`/transactions/${hash}`);
      if (transactionTouchesContract(tx.envelope_xdr, passphrase, contractId)) {
        matchedHashes.add(hash);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, uniqueHashes.length) || 1 }, worker));

  // Built once, O(1) lookups below instead of a candidates.find() per matched
  // hash — candidates can hold up to MAX_OPS (10,000) entries, so a linear scan
  // per match scaled badly on a busy contract near that cap. Keep the FIRST op
  // per hash, matching what candidates.find() returned — a transaction with 2+
  // invoke_host_function operations (real, e.g. batched/multi-call transactions)
  // would otherwise silently report sourceAccount from whichever op happened to
  // be processed last, which depends on parallel chunk-fetch timing, not
  // transaction operation order. `new Map(candidates.map(...))` (a first attempt
  // at this same optimization) gets this backwards — later entries overwrite
  // earlier ones — so it's built explicitly with a "first wins" guard instead.
  const candidateByHash = new Map();
  for (const c of candidates) {
    if (!candidateByHash.has(c.transaction_hash)) candidateByHash.set(c.transaction_hash, c);
  }

  return {
    mode: 'horizon-fallback',
    fidelityNote:
      'Outside Soroban RPC event retention — showing invocation transactions from Horizon (decoded from XDR, no per-event detail).',
    truncated,
    invocations: Array.from(matchedHashes).map((hash) => {
      const op = candidateByHash.get(hash);
      return { transactionHash: hash, createdAt: op.created_at, sourceAccount: op.source_account };
    }),
  };
}

function transactionTouchesContract(envelopeXdr, passphrase, contractId) {
  try {
    const tx = TransactionBuilder.fromXDR(envelopeXdr, passphrase);
    const ops = tx.operations || (tx.innerTransaction ? tx.innerTransaction.operations : []);
    return ops.some((op) => {
      if (op.type !== 'invokeHostFunction') return false;
      const fn = op.func;
      if (fn?.switch?.().name !== 'hostFunctionTypeInvokeContract') return false;
      const invoke = fn.invokeContract();
      try {
        const decoded = Address.fromScAddress(invoke.contractAddress()).toString();
        // Belt-and-suspenders: confirm the decode actually produced a valid
        // contract strkey before trusting the equality check below — SDK
        // version differences in what .toString() returns shouldn't be
        // assumed silently correct.
        return StrKey.isValidContract(decoded) && decoded === contractId;
      } catch {
        return false;
      }
    });
  } catch {
    return false; // malformed/unsupported envelope — skip rather than false-positive
  }
}

export default router;
