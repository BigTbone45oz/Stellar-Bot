import { Router } from 'express';
import { TransactionBuilder, Networks, Address, StrKey } from '@stellar/stellar-sdk';
import {
  resolveNetwork,
  DUNE_QUERY_ID,
  DUNE_SOROSWAP_TREND_QUERY_ID,
  DUNE_SOROSWAP_FUNCTIONS_QUERY_ID,
  DUNE_NETWORK_TRADES_QUERY_ID,
  DUNE_PROTOCOL_FUNCTIONS_QUERY_ID,
} from '../config.js';
import { makeHorizonClient } from '../horizonClient.js';
import { makeSorobanClient } from '../sorobanClient.js';
import { ledgerSequenceForTimestamp, STELLAR_EXPERT_NETWORK } from '../ledgerTime.js';
import { cached, TTL, ttlForRange } from '../cache.js';
import { fetchRangeParallel } from '../rangeFetch.js';
import { parseDateRange } from '../validate.js';
import { priceMovementList, sortMovementList } from '../assetPricing.js';
import { duneConfigured, fetchDuneQueryResults, duneRouteUnavailable } from '../duneClient.js';

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
// calls. Can't come from live Horizon/RPC scanning (would mean paging ~13.5M
// ledgers) — backed by a saved Dune query (DUNE_QUERY_ID) against Dune's
// pre-indexed `stellar.history_operations`/`stellar.history_effects` tables.
// Pubnet-only — Dune doesn't index testnet, and an all-time total wouldn't
// mean much there anyway since SDF periodically resets it.
router.get('/all-time', async (req, res, next) => {
  try {
    const net = resolveNetwork(req.query.network);
    const unavailable = duneRouteUnavailable(net, DUNE_QUERY_ID, 'DUNE_QUERY_ID', 'All-time totals');
    if (unavailable) return res.json(unavailable);

    // Dune's materialized result barely changes minute-to-minute, so the RAW
    // amounts are cached generously. Pricing is deliberately NOT included in
    // that cache — USD conversion depends on a live asset price, which
    // changes far more often than the Dune amounts do, so it's re-priced on
    // every request. Cheap in practice: each asset's price is itself already
    // cached at TTL.RECENT inside priceMovementList/fetchAssetUsdPrice.
    const { assets: rawAssets, truncated } = await cached('contractsAllTimeRaw:pubnet', TTL.FINALIZED, async () => {
      const rows = await fetchDuneQueryResults(DUNE_QUERY_ID);
      return {
        truncated: Boolean(rows.truncated),
        assets: rows
          .map((r) => ({
            code: r.asset_code || 'XLM',
            issuer: r.asset_issuer || null,
            totalAmount: Number(r.total_amount) || 0,
            effectCount: Number(r.effect_count) || 0,
          }))
          .filter((a) => a.totalAmount > 0),
      };
    });

    // Cloned, not mutated in place — `rawAssets` is the same object `cached()`
    // returns on every call within the TTL window; writing priceUsd/totalUsd
    // directly onto it would bake a stale price into the cached raw data.
    const assets = rawAssets.map((a) => ({ ...a }));
    const expertNetwork = STELLAR_EXPERT_NETWORK.pubnet;
    await priceMovementList(assets, expertNetwork, 'pubnet', 'totalAmount');
    sortMovementList(assets, 'totalAmount');

    const totalMovedUsd = assets.reduce((sum, a) => sum + (a.totalUsd || 0), 0);
    const pricedAssetCount = assets.filter((a) => a.totalUsd !== null).length;

    res.json({
      available: true,
      truncated,
      totalMovedUsd,
      pricedAssetCount,
      assetCount: assets.length,
      topAssets: assets.slice(0, TOP_ALL_TIME_ASSETS_SHOWN),
    });
  } catch (err) {
    next(err);
  }
});

// Day-bucketed call-volume trend, plus a per-function breakdown, for a
// specific, confirmed-Soroban protocol, since launch. Currently Soroswap only
// (contract addresses verified against its own GitHub docs, filtered in the
// Dune queries themselves). Deliberately NOT extended to other DeFiLlama-listed
// Stellar "DEX" protocols yet — several (Aquarius, LumenSwap, Scopuly) predate
// Soroban and run mostly on Stellar's classic protocol-level DEX/liquidity
// pools, not smart contracts; mixing that in would misrepresent this as
// "Soroban usage" when much of it isn't.
//
// The function-name breakdown comes from a second Dune query against
// `parameters_decoded` — Dune decodes each invoke_host_function op's
// parameters as a ROW("type" varchar, "value" varchar) array; index 2's
// `.value` is the invoked function's Symbol, per InvokeContractArgs' fixed
// struct field order (contractAddress, functionName, args) — same fact
// payments.js's decodeInvokedFunctionName relies on for raw XDR, decoded by
// Dune instead of by us here.
router.get('/protocol-trend', async (req, res, next) => {
  try {
    const net = resolveNetwork(req.query.network);
    const unavailable = duneRouteUnavailable(net, DUNE_SOROSWAP_TREND_QUERY_ID, 'DUNE_SOROSWAP_TREND_QUERY_ID', 'Protocol trends');
    if (unavailable) return res.json(unavailable);

    const data = await cached('contractsProtocolTrend:soroswap:pubnet:v2', TTL.FINALIZED, async () => {
      // Two independent Dune queries, fetched concurrently. The functions
      // query is optional and caught independently so a transient failure on
      // it (rate limit, timeout) can't take down the primary call-volume
      // trend, which otherwise succeeded fine.
      const functionsConfigured = duneConfigured(DUNE_SOROSWAP_FUNCTIONS_QUERY_ID);
      const [rows, fnRows] = await Promise.all([
        fetchDuneQueryResults(DUNE_SOROSWAP_TREND_QUERY_ID),
        functionsConfigured ? fetchDuneQueryResults(DUNE_SOROSWAP_FUNCTIONS_QUERY_ID).catch(() => null) : Promise.resolve(null),
      ]);
      // Read directly off the untransformed `rows`/`fnRows` arrays — a
      // .map()/.filter() copy would drop the `truncated` property
      // fetchDuneQueryResults attaches (see duneClient.js).
      let truncated = Boolean(rows.truncated) || Boolean(fnRows?.truncated);

      const byDay = new Map();
      for (const r of rows) {
        const entry = byDay.get(r.day) || { day: r.day, invokeCount: 0, createCount: 0 };
        if (r.function === 'HostFunctionTypeHostFunctionTypeInvokeContract') entry.invokeCount += Number(r.call_count) || 0;
        if (r.function === 'HostFunctionTypeHostFunctionTypeCreateContract') entry.createCount += Number(r.call_count) || 0;
        byDay.set(r.day, entry);
      }

      const daily = Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? -1 : 1));

      // Function-name breakdown is optional — the call-volume trend above
      // still works if this second query isn't configured.
      let functionTotals = [];
      // Object.create(null), not {} — the key is a Soroban contract's own
      // author-chosen function name (attacker-controlled). A plain {} with a
      // key literally named "__proto__" wouldn't create an own enumerable
      // property — it would reassign the prototype via the inherited setter,
      // silently dropping that function's data with no error.
      let dailyByFunction = Object.create(null);
      // fnRows is null both when the query isn't configured and when it's
      // configured but the fetch failed — both degrade the same way.
      if (fnRows) {
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
        truncated,
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

const NETWORK_TRADES_TOP_N = 15;
const NETWORK_TRADES_MIN_NAME_LEN = 3; // drops cryptic 1-2 char names (e.g. "s", "cm")

// Network-wide (every Soroban contract, not just known protocols) breakdown of
// what function gets called when a real trade happens — same swap-detection
// signal payments.js uses live (an operation that moved 2+ distinct assets),
// run via Dune against full history instead of a live-Horizon date range.
// Deliberately NOT protocol-labeled — there's no contract_id-to-protocol-name
// mapping network-wide, only for the handful manually verified (currently
// just Soroswap) — so this shows raw function names, including real noise
// (e.g. "yeet", a real, non-cryptic but uninformative function name). Top 15
// by call count, not the full ~94 distinct names in the raw query.
router.get('/network-trading-activity', async (req, res, next) => {
  try {
    const net = resolveNetwork(req.query.network);
    const unavailable = duneRouteUnavailable(net, DUNE_NETWORK_TRADES_QUERY_ID, 'DUNE_NETWORK_TRADES_QUERY_ID', 'Network-wide trading activity');
    if (unavailable) return res.json(unavailable);

    const data = await cached('contractsNetworkTradingActivity:pubnet', TTL.FINALIZED, async () => {
      const rows = await fetchDuneQueryResults(DUNE_NETWORK_TRADES_QUERY_ID);

      const totals = new Map();
      const dailyRaw = new Map(); // name -> [{day, callCount}]
      for (const r of rows) {
        const name = r.function_name;
        if (!name || name.length < NETWORK_TRADES_MIN_NAME_LEN) continue;
        const count = Number(r.call_count) || 0;
        totals.set(name, (totals.get(name) || 0) + count);
        if (!dailyRaw.has(name)) dailyRaw.set(name, []);
        dailyRaw.get(name).push({ day: r.day, callCount: count });
      }

      const functionTotals = Array.from(totals.entries())
        .map(([name, callCount]) => ({ name, callCount }))
        .sort((a, b) => b.callCount - a.callCount)
        .slice(0, NETWORK_TRADES_TOP_N);

      // Object.create(null), not {} — see /protocol-trend above.
      const dailyByFunction = Object.create(null);
      for (const f of functionTotals) dailyByFunction[f.name] = dailyRaw.get(f.name) || [];

      return {
        available: true,
        truncated: Boolean(rows.truncated),
        totalMatchedCalls: Array.from(totals.values()).reduce((sum, c) => sum + c, 0),
        functionTotals,
        dailyByFunction,
      };
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

const PROTOCOL_FUNCTIONS_TOP_N = 15; // per protocol, same display-scope cap as network-trading-activity

// Real per-function call breakdown for a handful of manually-verified
// protocols beyond just Soroswap — "what are people actually using each one
// for." Deliberately NOT filtered by the "moved 2+ distinct assets" swap
// signal used elsewhere: several of these protocols aren't DEXs — Blend is a
// lending market, where a real call (supply/borrow/repay) moves exactly one
// asset and would be invisible to a swap filter. Covers more protocols in one
// query via a contract-address-to-protocol-name lookup built from
// StellarExpert's Directory API rather than hand-verified addresses per
// protocol.
router.get('/protocol-functions', async (req, res, next) => {
  try {
    const net = resolveNetwork(req.query.network);
    const unavailable = duneRouteUnavailable(net, DUNE_PROTOCOL_FUNCTIONS_QUERY_ID, 'DUNE_PROTOCOL_FUNCTIONS_QUERY_ID', 'Protocol usage breakdown');
    if (unavailable) return res.json(unavailable);

    const data = await cached('contractsProtocolFunctions:pubnet', TTL.FINALIZED, async () => {
      const rows = await fetchDuneQueryResults(DUNE_PROTOCOL_FUNCTIONS_QUERY_ID);

      const byProtocol = new Map(); // protocolName -> Map<functionName, callCount>
      for (const r of rows) {
        const protocol = r.protocol_name;
        if (!protocol) continue;
        const functionName = r.function_name || 'unknown';
        const callCount = Number(r.call_count) || 0;
        const fnTotals = byProtocol.get(protocol) || new Map();
        fnTotals.set(functionName, (fnTotals.get(functionName) || 0) + callCount);
        byProtocol.set(protocol, fnTotals);
      }

      // Object.create(null), not {} — protocol names here come from the Dune
      // query's VALUES lookup (our own choosing, lower risk than a contract's
      // own function name), but same defensive shape as dailyByFunction above
      // for consistency.
      const protocols = Object.create(null);
      for (const [protocol, fnTotals] of byProtocol) {
        const functionTotals = Array.from(fnTotals.entries())
          .map(([name, callCount]) => ({ name, callCount }))
          .sort((a, b) => b.callCount - a.callCount);
        protocols[protocol] = {
          totalCalls: functionTotals.reduce((sum, f) => sum + f.callCount, 0),
          functionTotals: functionTotals.slice(0, PROTOCOL_FUNCTIONS_TOP_N),
        };
      }

      return { available: true, truncated: Boolean(rows.truncated), protocols };
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
    // Floored to 10 minutes (coarser than parseDateRange's minute-flooring of
    // start/end) so this doesn't defeat ledgerSequenceForTimestamp's cache
    // with a fresh key on every request — RETENTION_DAYS is already a
    // safety margin, so a few minutes of slop is immaterial.
    const TEN_MIN_MS = 10 * 60 * 1000;
    const retentionCutoffMs =
      Math.floor((Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000) / TEN_MIN_MS) * TEN_MIN_MS;

    const cacheKey = `contractActivity:${net.key}:${id}:${start}:${end}`;
    const data = await cached(cacheKey, ttlForRange(endMs), async () => {
      // Independent upstreams (Soroban RPC vs. Horizon) — run concurrently.
      const [eventsSegment, fallbackSegment] = await Promise.all([
        endMs >= retentionCutoffMs
          ? fetchViaRpcEvents(net, horizon, id, Math.max(startMs, retentionCutoffMs), endMs)
          : null,
        startMs < retentionCutoffMs
          ? fetchViaHorizonFallback(
              horizon,
              net.key,
              id,
              start,
              new Date(Math.min(endMs, retentionCutoffMs)).toISOString(),
              passphraseFor(net.key)
            )
          : null,
      ]);
      const segments = [eventsSegment, fallbackSegment].filter(Boolean);

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
  // RETENTION_DAYS (6) is a safety margin under Soroban RPC's approximate
  // "~7 days" retention, not a guarantee — a public node can still reject
  // `startLedger` as outside its actual retained range (a SorobanRpcError).
  // Wrapped in try/catch (including the ledgerSequenceForTimestamp call, not
  // just the polling loop) so a boundary case degrades just this segment
  // instead of failing the whole /:id/activity response.
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
  // Wrapped like fetchViaRpcEvents above — a transient Horizon failure here
  // should degrade just this segment, not reject the whole /:id/activity
  // response via Promise.all and discard an already-successful events segment.
  try {
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
    // contract's address as plain text — only recoverable by decoding the
    // transaction's raw XDR (string-matching encoded bytes can never match).
    //
    // Fetching each unique transaction's envelope is independent work, so it
    // runs with bounded concurrency rather than one-at-a-time.
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

    // Built once for O(1) lookups instead of a candidates.find() per matched
    // hash (candidates can hold up to MAX_OPS entries). Keeps the FIRST op
    // per hash — a transaction with 2+ invoke_host_function operations
    // (e.g. batched/multi-call) would otherwise report sourceAccount from
    // whichever op happened to be processed last, which depends on parallel
    // chunk-fetch timing, not transaction operation order.
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
  } catch (err) {
    return {
      mode: 'horizon-fallback',
      fidelityNote: `Historical invocation data unavailable for this range: ${err.message}`,
      truncated: false,
      invocations: [],
    };
  }
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
