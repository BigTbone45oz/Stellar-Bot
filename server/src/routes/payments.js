import { Router } from 'express';
import { xdr } from '@stellar/stellar-sdk';
import { resolveNetwork } from '../config.js';
import { makeHorizonClient } from '../horizonClient.js';
import { ledgerSequenceForTimestamp, STELLAR_EXPERT_NETWORK } from '../ledgerTime.js';
import { cached, TTL, ttlForRange } from '../cache.js';
import { fetchRangeParallel } from '../rangeFetch.js';
import { parseDateRange } from '../validate.js';
import { fetchAssetUsdPrice } from '../assetPricing.js';

const router = Router();

// Plain payment-shaped operations (as opposed to invoke_host_function calls) —
// what actually moved from account to account, Stellar's original use case.
// path_payment_* ops have two legs (what the sender paid vs. what the receiver
// got, possibly different assets); only the receive-side asset/amount is
// tracked here, matching "what value arrived" rather than modeling both legs.
const PAYMENT_OP_TYPES = new Set(['payment', 'path_payment_strict_send', 'path_payment_strict_receive']);

// USD-prices a list of { code, issuer, total } entries in place, using the same
// bounded worker-pool shape used elsewhere in this codebase (contracts.js's
// per-tx fetch, assets.js's /details) for independent lookups — shared by both
// the contract-movement and payment-movement pricing passes below so the same
// concurrency/caching logic isn't duplicated.
async function priceMovementList(movementList, expertNetwork, netKey) {
  if (!expertNetwork) {
    for (const entry of movementList) {
      entry.priceUsd = null;
      entry.totalUsd = null;
    }
    return;
  }
  const CONCURRENCY = 6;
  let nextIdx = 0;
  async function priceWorker() {
    while (nextIdx < movementList.length) {
      const entry = movementList[nextIdx++];
      entry.priceUsd = await cached(
        `assetPriceUsd:${netKey}:${entry.code}:${entry.issuer || 'native'}`,
        TTL.RECENT,
        () => fetchAssetUsdPrice(expertNetwork, entry.code, entry.issuer)
      ).catch(() => null);
      entry.totalUsd = entry.priceUsd !== null ? entry.total * entry.priceUsd : null;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, movementList.length) || 1 }, priceWorker));
}

// Adds one observed amount to a `Map<assetKey, {code, issuer, total, changeCount}>`,
// creating the entry on first sight — the "get or initialize, then accumulate"
// step shared by every movement-tracking loop below (contract-caused and
// plain-payment), pulled out so both stay in sync if the entry shape ever changes.
function accumulateMovement(map, assetKey, code, issuer, amount) {
  const entry = map.get(assetKey) || { assetKey, code, issuer, total: 0, changeCount: 0 };
  entry.total += Number(amount);
  entry.changeCount += 1;
  map.set(assetKey, entry);
}

// Sorts a priced movement list by USD value when known (what "top assets
// moved" should mean), falling back to raw change count for anything price
// lookup failed on — those still get listed, just pushed below the priced
// ones rather than dropped, so a failed price lookup can't silently hide
// real activity.
function sortMovementList(movementList) {
  movementList.sort((a, b) => {
    if (a.totalUsd !== null && b.totalUsd !== null) return b.totalUsd - a.totalUsd;
    if (a.totalUsd !== null) return -1;
    if (b.totalUsd !== null) return 1;
    return b.changeCount - a.changeCount;
  });
}

// A Soroban `invoke_host_function` op with function type InvokeContract carries the
// protocol-level struct `InvokeContractArgs { contractAddress, functionName, args }`
// — Horizon serializes those three fields, in that fixed order, as this op's flat
// `parameters` array. So parameters[1] is always the invoked function's name (an
// ScVal Symbol), not a Horizon convention that could shift — it's the XDR struct's
// field order. Verified live: decoded 198 real mainnet invoke_host_function ops,
// 0 decode failures, names came back as plausible real function names ("work",
// "harvest", "transfer").
function decodeInvokedFunctionName(op) {
  if (!Array.isArray(op.parameters) || op.parameters.length < 2) return null;
  const fnParam = op.parameters[1];
  if (fnParam.type !== 'Sym') return null;
  try {
    const scval = xdr.ScVal.fromXDR(fnParam.value, 'base64');
    return scval.switch().name === 'scvSymbol' ? scval.sym().toString() : null;
  } catch {
    return null; // malformed/unexpected XDR — skip rather than throw the whole request
  }
}

// Operation-type breakdown isn't in the /ledgers summary, so this does real
// /operations paging — but only once per date range, since the aggregated
// result (not the raw records) is what gets cached.
router.get('/breakdown', async (req, res, next) => {
  try {
    const { start, end, endMs } = parseDateRange(req.query);
    const net = resolveNetwork(req.query.network);
    const horizon = makeHorizonClient(net.horizon);

    const cacheKey = `opsBreakdown:${net.key}:${start}:${end}`;
    const data = await cached(cacheKey, ttlForRange(endMs), async () => {
      const [startSeq, endSeq] = await Promise.all([
        ledgerSequenceForTimestamp(horizon, net.key, start),
        ledgerSequenceForTimestamp(horizon, net.key, end),
      ]);

      const byType = new Map();
      // invoke_host_function is one Horizon operation `type`, but it covers three
      // meaningfully different actions (call a contract / deploy one / upload wasm),
      // distinguished by the op's own `function` field — tallied separately so
      // callers that care (the Smart Contracts page) can break it out further
      // without a second /operations pass over the same range.
      const byFunction = new Map();
      // Which specific contract function got called (e.g. "transfer", "swap") —
      // the closest thing to "what people are actually trying to do" with a
      // contract, as opposed to just knowing an invocation happened. Unlike
      // op `type`/`function` above, these names are chosen by each contract's own
      // author, not defined by the protocol — see contractFunctions.js on the
      // client for how that distinction is presented.
      const byInvokedFunction = new Map();

      // Real, verifiable asset movement caused by contract calls — Horizon's own
      // `asset_balance_changes` on invoke_host_function ops, populated only for calls
      // that move a classic Stellar asset or a Stellar Asset Contract (SAC)-wrapped
      // token (confirmed live: 4 of ~2,000 sampled recent mainnet ops had this field
      // — most Soroban activity is pure custom-token/contract-storage state that
      // Horizon can't see at this level, so this is a real but partial signal, not a
      // general "what does this contract do" answer).
      const assetMovement = new Map(); // assetKey -> { code, issuer, total, changeCount }
      const movementByType = new Map(); // 'mint'|'transfer'|'clawback'|'burn' -> count
      const swaps = []; // ops that moved 2+ distinct assets in one call — a provable swap

      // Real payment value, separate from contract-caused movement above — Stellar's
      // original use case (cross-border payments), not trading. Same shape as
      // assetMovement/movementByType above so the two reuse the same
      // pricing/sorting helpers.
      const paymentMovement = new Map(); // assetKey -> { code, issuer, total, changeCount }
      const paymentMovementByType = new Map(); // op.type -> count
      // create_account's starting_balance is real XLM funding, tracked separately
      // (not folded into paymentMovement — see the create_account branch below
      // for why) since it's a "new account exists" signal, not a payment.
      let newAccountFundingXlm = 0;

      // Day-bucketed new-account/trustline-change counts — the Network Growth
      // tab's trend chart. Horizon has no aggregate endpoint for "op type X per
      // day" (unlike /ledgers, which gives tx/op *totals* per ledger but not a
      // per-type breakdown) — the only way to get this is enumerating every
      // operation, same as the rest of this route already does, so this trend
      // is bound by the same op-density-based date-range limits as everything
      // else here (see OPS_BREAKDOWN_RANGE_PRESETS on the client).
      const dailyGrowth = new Map(); // day (YYYY-MM-DD) -> { day, newAccounts, newTrustlines }
      function bumpDailyGrowth(createdAt, field) {
        const day = createdAt.slice(0, 10);
        const entry = dailyGrowth.get(day) || { day, newAccounts: 0, newTrustlines: 0 };
        entry[field] += 1;
        dailyGrowth.set(day, entry);
      }

      // Operation density per ledger varies a lot (a few ops to hundreds), unlike
      // /ledgers' exact 1:1 — 20 ledgers/chunk is a rough aim for ~1 page/chunk on
      // average, not a guarantee. fetchRangeParallel pages within a chunk correctly
      // either way; this only affects how evenly the parallel work is balanced.
      const { truncated } = await fetchRangeParallel(horizon, '/operations', startSeq, endSeq, {
        ledgersPerChunk: 20,
        maxRecords: 20_000, // safety cap; widen via a paid Horizon provider if needed
        onPage: (records) => {
          for (const op of records) {
            byType.set(op.type, (byType.get(op.type) || 0) + 1);
            if (op.type === 'invoke_host_function' && op.function) {
              byFunction.set(op.function, (byFunction.get(op.function) || 0) + 1);
              if (op.function === 'HostFunctionTypeHostFunctionTypeInvokeContract') {
                const fnName = decodeInvokedFunctionName(op);
                if (fnName) byInvokedFunction.set(fnName, (byInvokedFunction.get(fnName) || 0) + 1);
              }

              if (Array.isArray(op.asset_balance_changes) && op.asset_balance_changes.length > 0) {
                const distinctAssets = new Set();
                for (const c of op.asset_balance_changes) {
                  const assetKey = c.asset_type === 'native' ? 'native' : `${c.asset_code}:${c.asset_issuer}`;
                  distinctAssets.add(assetKey);
                  accumulateMovement(
                    assetMovement,
                    assetKey,
                    c.asset_type === 'native' ? 'XLM' : c.asset_code,
                    c.asset_type === 'native' ? null : c.asset_issuer,
                    c.amount
                  );
                  movementByType.set(c.type, (movementByType.get(c.type) || 0) + 1);
                }
                if (distinctAssets.size >= 2 && swaps.length < 50) {
                  swaps.push({
                    // A transaction can contain multiple invoke_host_function
                    // operations, each independently qualifying as a swap here —
                    // transactionHash alone isn't unique per swap in that case
                    // (same class of bug already fixed once for the payments list
                    // by adding the operation's own id; this list needed the same
                    // treatment, missed because it was added later).
                    id: op.id,
                    transactionHash: op.transaction_hash,
                    createdAt: op.created_at,
                    sourceAccount: op.source_account,
                    legs: op.asset_balance_changes.map((c) => ({
                      code: c.asset_type === 'native' ? 'XLM' : c.asset_code,
                      issuer: c.asset_type === 'native' ? null : c.asset_issuer,
                      type: c.type,
                      amount: c.amount,
                    })),
                  });
                }
              }
            } else if (PAYMENT_OP_TYPES.has(op.type)) {
              // path_payment_* ops carry the *receive-side* asset directly on
              // asset_type/asset_code/asset_issuer (Horizon's convention — the
              // source-side asset, if different, lives under source_asset_type/
              // source_asset_code/source_asset_issuer, not tracked here; see the
              // PAYMENT_OP_TYPES comment above for why).
              const assetKey = op.asset_type === 'native' ? 'native' : `${op.asset_code}:${op.asset_issuer}`;
              accumulateMovement(
                paymentMovement,
                assetKey,
                op.asset_type === 'native' ? 'XLM' : op.asset_code,
                op.asset_type === 'native' ? null : op.asset_issuer,
                op.amount
              );
              paymentMovementByType.set(op.type, (paymentMovementByType.get(op.type) || 0) + 1);
            } else if (op.type === 'create_account') {
              // starting_balance is real XLM funding, not just an account-creation
              // count — but tracked separately from paymentMovement above, not
              // folded into it: blending it into the same "native" entry would
              // contaminate that row's changeCount (rendered as "# of payments")
              // with account-funding events that aren't payments.
              newAccountFundingXlm += Number(op.starting_balance);
              bumpDailyGrowth(op.created_at, 'newAccounts');
            } else if (op.type === 'change_trust') {
              bumpDailyGrowth(op.created_at, 'newTrustlines');
            }
          }
        },
      });

      // USD-price each distinct asset touched (usually a handful — actively-traded
      // assets, not the full 100+ from assets.js's /top). Contract movement and
      // payment movement can share assets (native XLM commonly appears in both),
      // and cached() has no in-flight-request dedup (see CLAUDE.md's "Consciously
      // deferred" note) — pricing the two lists independently would commonly fire
      // two concurrent, duplicate upstream lookups for the same asset within one
      // request. Priced once via a deduped union instead, then applied back to
      // both maps by assetKey.
      const expertNetwork = STELLAR_EXPERT_NETWORK[net.key];
      const uniqueAssets = new Map(); // assetKey -> { code, issuer }
      for (const [key, entry] of assetMovement) uniqueAssets.set(key, { code: entry.code, issuer: entry.issuer });
      for (const [key, entry] of paymentMovement) uniqueAssets.set(key, { code: entry.code, issuer: entry.issuer });
      const priceList = Array.from(uniqueAssets.entries()).map(([key, v]) => ({ key, ...v, total: 1, changeCount: 0 }));
      await priceMovementList(priceList, expertNetwork, net.key);
      const priceByAssetKey = new Map(priceList.map((p) => [p.key, p.priceUsd]));

      function applyPricing(map) {
        for (const entry of map.values()) {
          const priceUsd = priceByAssetKey.get(entry.assetKey);
          entry.priceUsd = priceUsd ?? null;
          entry.totalUsd = entry.priceUsd !== null ? entry.total * entry.priceUsd : null;
        }
      }
      applyPricing(assetMovement);
      applyPricing(paymentMovement);

      const movementList = Array.from(assetMovement.values());
      const paymentMovementList = Array.from(paymentMovement.values());
      sortMovementList(movementList);
      sortMovementList(paymentMovementList);

      const totalMovedUsd = movementList.reduce((sum, e) => sum + (e.totalUsd || 0), 0);
      const pricedAssetCount = movementList.filter((e) => e.totalUsd !== null).length;
      // Lower bound, not exact — same caveat as totalMovedUsd above: only the
      // assets whose USD price actually resolved are summed.
      const totalPaymentVolumeUsd = paymentMovementList.reduce((sum, e) => sum + (e.totalUsd || 0), 0);
      const pricedPaymentAssetCount = paymentMovementList.filter((e) => e.totalUsd !== null).length;

      return {
        startSeq,
        endSeq,
        truncated,
        byType: Array.from(byType.entries()).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
        byFunction: Array.from(byFunction.entries())
          .map(([func, count]) => ({ function: func, count }))
          .sort((a, b) => b.count - a.count),
        byInvokedFunction: Array.from(byInvokedFunction.entries())
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 50), // long tail cut here, not a "truncated" fetch — just display scope
        assetMovement: movementList,
        // Total is a lower bound, not exact — it's the sum of only the assets whose
        // USD price we could actually resolve (see pricedAssetCount vs
        // assetMovement.length to know if any were skipped).
        totalMovedUsd,
        pricedAssetCount,
        movementByType: Array.from(movementByType.entries())
          .map(([type, count]) => ({ type, count }))
          .sort((a, b) => b.count - a.count),
        swaps,

        // Real payment value (payment/path_payment_* only — create_account's
        // funding is tracked separately below, not blended in here). Same "lower
        // bound, not exact" caveat: only assets that priced successfully are summed.
        paymentMovement: paymentMovementList,
        totalPaymentVolumeUsd,
        pricedPaymentAssetCount,
        paymentMovementByType: Array.from(paymentMovementByType.entries())
          .map(([type, count]) => ({ type, count }))
          .sort((a, b) => b.count - a.count),

        // Network growth — pulled from byType (already tallied above from the
        // same /operations pass, no extra request) rather than making callers
        // search that array themselves for these two specific op types.
        newAccountCount: byType.get('create_account') || 0,
        newAccountFundingXlm,
        // NOTE: change_trust covers establishing AND modifying/removing a
        // trustline (Horizon's operation record doesn't distinguish which —
        // that would require diffing against the account's prior trustline
        // state, which this route doesn't do). "Trustline changes", not
        // "new trustlines" — the client label reflects this.
        newTrustlineCount: byType.get('change_trust') || 0,
        dailyGrowth: Array.from(dailyGrowth.values()).sort((a, b) => (a.day < b.day ? -1 : 1)),
      };
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
