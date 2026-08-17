import { Router } from 'express';
import { resolveNetwork } from '../config.js';
import { makeHorizonClient } from '../horizonClient.js';
import { cached, TTL, ttlForRange } from '../cache.js';
import { parseDateRange } from '../validate.js';
import { STELLAR_EXPERT_NETWORK } from '../ledgerTime.js';
import { STELLAR_EXPERT_URL } from '../config.js';
import { fetchJsonOrThrow, fetchTextOrNull } from '../fetchWithTimeout.js';

const router = Router();
const ISSUER_RE = /^G[A-Z2-7]{55}$/;
const ASSET_ID_RE = new RegExp(`^(.+)-(${ISSUER_RE.source.slice(1, -1)})-\\d+$`);
const VALID_RESOLUTIONS_MS = [60_000, 300_000, 900_000, 3_600_000, 86_400_000, 604_800_000];

// Horizon has no "top assets" ranking of any kind (no sort param on /assets at all —
// see the /search route above, which just filters by code). StellarExpert's asset
// list, sorted by their composite `rating`, is the only source of this ranking; unlike
// ledgerTime.js's use of StellarExpert, there's no Horizon-based fallback possible here
// if it's unreachable, since the underlying capability doesn't exist upstream.
const TOP_ASSETS_PAGE_SIZE = 50; // StellarExpert silently clamps `limit` to 50, verified empirically

function parseAssetId(assetId) {
  if (assetId === 'XLM') return { code: 'XLM', issuer: null, native: true };
  const m = assetId.match(ASSET_ID_RE);
  if (!m) return null; // unrecognized format — skip rather than guess
  return { code: m[1], issuer: m[2], native: false };
}

async function fetchStellarExpertAssetPage(expertNetwork, cursor) {
  const url = `${STELLAR_EXPERT_URL}/explorer/${expertNetwork}/asset?sort=rating&order=desc&limit=${TOP_ASSETS_PAGE_SIZE}&cursor=${cursor}`;
  return fetchJsonOrThrow(url, { timeoutMs: 8000, headers: { Accept: 'application/json' }, label: 'StellarExpert asset lookup' });
}

// SEP-1 stellar.toml CURRENCIES blocks look like:
//   [[CURRENCIES]]
//   code = "USDC"
//   issuer = "G..."
//   name = "USD Coin"
// A regex parse (rather than a full TOML parser dependency) is good enough here —
// we only need one string value out of one matching block, not general TOML fidelity.
const CURRENCY_BLOCK_RE = /\[\[CURRENCIES\]\]([\s\S]*?)(?=\[\[CURRENCIES\]\]|\n\[|$)/g;

async function fetchTomlAssetName(domain, code, issuer) {
  // unreachable domain, no toml, malformed toml — name just stays unknown
  const text = await fetchTextOrNull(`https://${domain}/.well-known/stellar.toml`);
  if (!text) return null;
  for (const m of text.matchAll(CURRENCY_BLOCK_RE)) {
    const block = m[1];
    if (block.match(/code\s*=\s*"([^"]+)"/)?.[1] !== code) continue;
    if (block.match(/issuer\s*=\s*"([^"]+)"/)?.[1] !== issuer) continue;
    return block.match(/\bname\s*=\s*"([^"]*)"/)?.[1] || null;
  }
  return null;
}

// XLM can't be paired against itself, so Horizon's order_book/trade_aggregations
// (both need two distinct assets) don't work for native the same way they do for
// every other asset in this table. Rather than leave XLM's row permanently blank,
// its liquidity/volume are computed against this single reference pair instead —
// Circle's canonical USDC issuer, the deepest/most liquid market XLM trades in.
// Known limitation: this captures XLM/USDC activity only, not XLM's combined
// liquidity/volume across every pair it trades in — same class of "partial, not
// exhaustive" caveat as everything else derived from a single order book/pair.
const NATIVE_REFERENCE_ASSET = { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' };

// `asset` is null for native (XLM), or {code, issuer} for a credit asset.
function assetParams(prefix, asset) {
  if (!asset) return { [`${prefix}_asset_type`]: 'native' };
  return {
    [`${prefix}_asset_type`]: asset.code.length > 4 ? 'credit_alphanum12' : 'credit_alphanum4',
    [`${prefix}_asset_code`]: asset.code,
    [`${prefix}_asset_issuer`]: asset.issuer,
  };
}

// Sum of outstanding DEX order-book depth (bids + asks) for a sellingAsset/buyingAsset
// pair, denominated in sellingAsset units — the closest real analogue Stellar has to
// "open interest" for a spot-only DEX (no futures/options market exists on-chain to
// have literal open interest). Every non-native asset call sells itself for native
// (so depth comes back in that asset's own units, matching how every other per-asset
// number in this route is denominated); the native row inverts this — see
// NATIVE_REFERENCE_ASSET — selling native for the reference asset, so depth comes
// back in native/XLM units instead. Known limitation: order-book offers only, not
// AMM liquidity-pool reserves for the same asset — a fuller number, deferred as
// extra scope for now.
async function fetchOrderBookDepth(horizon, sellingAsset, buyingAsset) {
  const page = await horizon.get('/order_book', {
    ...assetParams('selling', sellingAsset),
    ...assetParams('buying', buyingAsset),
    limit: 200,
  });
  const sum = (levels) => levels.reduce((acc, l) => acc + Number(l.amount), 0);
  return sum(page.bids) + sum(page.asks);
}

// Deliberately NOT using StellarExpert's `volume7d` for any of this, even for the
// '7d' option — spot-checked against Horizon directly (USDC, Aug 2026) and found
// StellarExpert's number ~50x larger than what trade_aggregations reports for the
// same 7-day window, i.e. they're scoping "volume" differently (likely including
// payments/off-DEX activity, not just SDEX+AMM trades). Blending that with a
// Horizon-computed 1h/1d/30d in the same dropdown would make the numbers incomparable
// across window choices. All windows go through this same Horizon path so they're at
// least internally consistent with each other.
const WINDOW_MS = { '1h': 3_600_000, '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
// Resolution must be strictly SMALLER than the window, not equal to it — Horizon's
// buckets are clock-aligned (to the hour/day), not rolling, so a "last 1 hour"
// query with 1h-sized buckets almost always lands entirely inside the still-forming
// current hour (zero completed buckets) or straddles a boundary Horizon won't
// partially return. Verified live against real trade data (USDC, Aug 2026): a 1h
// window with a 1h bucket returned $0 despite ~$155K of real volume in the
// immediately preceding hour; the same window with 5-minute buckets correctly
// summed to ~$21K. Using a finer resolution means only the sliver at the very
// edges of the window can be missed (a partial bucket at each end), not the whole
// window — real, small loss instead of a false zero.
const RESOLUTION_FOR_WINDOW = { '1h': 300_000, '1d': 3_600_000, '7d': 86_400_000, '30d': 86_400_000 };

// Horizon amount fields (base_volume/counter_volume) are already decimal strings,
// unlike StellarExpert's raw-stroop `supply`/`volume7d` — no BigInt/1e7 conversion
// needed here, see the /top supply handling above for the contrast.
//
// Returns volume denominated in counterAsset's units — every non-native call puts
// the target asset in the counter slot (base=native), so its own volume comes back
// in its own units; the native row inverts this (base=reference, counter=native) so
// XLM's volume comes back in native/XLM units too, matching the pattern.
async function fetchWindowVolume(horizon, baseAsset, counterAsset, window) {
  const endMs = Date.now();
  const startMs = endMs - WINDOW_MS[window];
  const resolutionMs = RESOLUTION_FOR_WINDOW[window]; // both values are in VALID_RESOLUTIONS_MS (top of file)
  const page = await horizon.get('/trade_aggregations', {
    ...assetParams('base', baseAsset),
    ...assetParams('counter', counterAsset),
    start_time: startMs,
    end_time: endMs,
    resolution: resolutionMs,
    order: 'asc',
    limit: 200,
  });
  return page._embedded.records.reduce((sum, r) => sum + Number(r.counter_volume), 0);
}

router.get('/search', async (req, res, next) => {
  try {
    const { code } = req.query;
    if (!code || !/^[A-Za-z0-9]{1,12}$/.test(code)) {
      return res.status(400).json({ error: 'code must be 1-12 alphanumeric characters' });
    }

    const net = resolveNetwork(req.query.network);
    const horizon = makeHorizonClient(net.horizon);

    const data = await cached(`assetSearch:${net.key}:${code}`, TTL.RECENT, async () => {
      const page = await horizon.get('/assets', { asset_code: code, limit: 20 });
      return page._embedded.records.map((a) => ({
        code: a.asset_code,
        issuer: a.asset_issuer,
        type: a.asset_type,
        numAccounts: a.accounts.authorized,
        amount: a.amount,
      }));
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

// Top 100 assets network-wide, ranked by StellarExpert's composite `rating` (age,
// activity, trustline count, liquidity, 7-day volume, interop — see their API response;
// not something this app computes itself). No Horizon equivalent exists — see the note
// above TOP_ASSETS_PAGE_SIZE.
router.get('/top', async (req, res, next) => {
  try {
    const net = resolveNetwork(req.query.network);
    const expertNetwork = STELLAR_EXPERT_NETWORK[net.key];
    if (!expertNetwork) {
      return res.status(400).json({ error: `Top-assets ranking isn't available for network "${net.key}"` });
    }

    const data = await cached(`topAssets:${net.key}`, TTL.RECENT, async () => {
      // Two pages of 50 cover the requested top 100. StellarExpert's cursor is a plain
      // offset (verified: requesting limit=5 returns a `next` link with cursor=5), so
      // both pages are independently fetchable — no need to wait on page 1's response
      // to know page 2's cursor.
      const [page1, page2] = await Promise.all([
        fetchStellarExpertAssetPage(expertNetwork, 0),
        fetchStellarExpertAssetPage(expertNetwork, TOP_ASSETS_PAGE_SIZE),
      ]);

      const records = [...(page1._embedded?.records || []), ...(page2._embedded?.records || [])];

      // rank is assigned AFTER filtering out unparseable entries (below), not from
      // this map's index — assigning it here would leave gaps in the displayed
      // ranking (1, 2, 4, 5, 7…) any time an entry gets dropped, while the client
      // still labels the table "Top 100" and renders `rank` as-is with no
      // renumbering of its own.
      return records
        .map((r) => {
          const parsed = parseAssetId(r.asset);
          if (!parsed) return null;

          // `price` is USD, not XLM — verified against known real-world prices (BTC/ETH
          // records came back ~$63k/~$1.9k, not XLM-denominated figures). Named priceUsd
          // here so it isn't confused with the XLM-denominated price-history route below.
          const priceUsd = r.price ?? null;

          // Ledger amounts (this `supply`) are fixed-point int64 stroops (7 decimals) —
          // the same magnitude problem as the TOID values in toid.js: XLM's raw supply
          // exceeds Number.MAX_SAFE_INTEGER, so Number(r.supply) would silently round the
          // integer part before it's even divided. BigInt keeps that exact; the whole-unit
          // result is always small enough to return to a plain JS number safely.
          let supply = null;
          if (typeof r.supply === 'string') {
            const stroops = BigInt(r.supply);
            const whole = stroops / 10_000_000n;
            const frac = stroops % 10_000_000n;
            supply = Number(whole) + Number(frac) / 1e7;
          }

          return {
            ...parsed,
            // tomlInfo.name (SEP-1 stellar.toml) only covers assets whose issuer both sets
            // a home_domain and publishes a matching CURRENCIES entry — most don't, so this
            // falls back to the code for most rows. The /details route below fills in a
            // real name (fetched from the issuer's own toml) lazily, per visible page.
            name: r.tomlInfo?.name || parsed.code,
            // Confirmed via StellarExpert's single-asset endpoint (which labels the same
            // three numbers `{total, authorized, funded}`): this list endpoint's compact
            // `trustlines` array is [total, authorized, funded] in that order. "Holders"
            // should mean accounts actually holding a balance, i.e. funded (trustlines[2]),
            // not just anyone who ever opened a trustline (trustlines[0]) — those can differ
            // by an order of magnitude for assets people claimed and never used.
            holders: Array.isArray(r.trustlines) ? r.trustlines[2] : null,
            volume7d: r.volume7d ?? null,
            priceUsd,
            supply,
            marketCapUsd: supply !== null && priceUsd !== null ? supply * priceUsd : null,
            rating: r.rating ?? null, // full breakdown (age/activity/trustlines/liquidity/volume7d/interop/average)
            domain: r.domain || null,
            orgName: r.tomlInfo?.orgName || null,
            createdAt: r.created ? new Date(r.created * 1000).toISOString() : null,
          };
        })
        .filter(Boolean)
        .slice(0, 100)
        .map((a, i) => ({ rank: i + 1, ...a }));
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

const MAX_DETAILS_BATCH = 20; // headroom over the client's 15-per-page table

// Per-asset detail lazily fetched only for the currently visible page of the top-100
// table (never all 100 at once) — real display name, live order-book depth, and
// (optionally) a custom-window trading volume. Each of these needs its own upstream
// call per asset, unlike everything in /top which comes from one shared StellarExpert
// list request, so this is deliberately opt-in/bounded rather than folded into /top.
//
// `assets` query param: comma-separated `CODE:ISSUER:DOMAIN` triples (ISSUER/DOMAIN
// may be empty — native XLM has neither; see NATIVE_REFERENCE_ASSET above for how
// its liquidity/volume are computed anyway. Name lookup is skipped for native and
// for any issuer with no known home domain).
router.get('/details', async (req, res, next) => {
  try {
    const net = resolveNetwork(req.query.network);
    const horizon = makeHorizonClient(net.horizon);

    const rawAssets = (req.query.assets || '').split(',').filter(Boolean);
    if (rawAssets.length === 0) return res.json({});
    if (rawAssets.length > MAX_DETAILS_BATCH) {
      return res.status(400).json({ error: `Too many assets in one request (max ${MAX_DETAILS_BATCH})` });
    }

    const parsed = [];
    for (const item of rawAssets) {
      const [code, issuer, domain] = item.split(':');
      const isNative = code === 'XLM' && !issuer;
      if (!code || !/^[A-Za-z0-9]{1,12}$/.test(code)) {
        return res.status(400).json({ error: `Malformed asset "${item}" — expected CODE:ISSUER:DOMAIN` });
      }
      if (!isNative && (!issuer || !ISSUER_RE.test(issuer))) {
        return res.status(400).json({ error: `Malformed asset "${item}" — expected CODE:ISSUER:DOMAIN` });
      }
      parsed.push({ code, issuer: issuer || null, domain: domain || null, key: item, isNative });
    }

    const window = req.query.window || '7d';
    if (!WINDOW_MS[window]) {
      return res.status(400).json({ error: `window must be one of ${Object.keys(WINDOW_MS).join(', ')}` });
    }

    const results = {};
    // Bounded-concurrency worker pool, same shape as contracts.js's per-transaction
    // fetch — independent per-asset work, no reason to serialize it.
    const CONCURRENCY = 6;
    let nextIdx = 0;
    async function worker() {
      while (nextIdx < parsed.length) {
        const { code, issuer, domain, key, isNative } = parsed[nextIdx++];
        const asset = isNative ? null : { code, issuer };
        const [liquidity, name, volume] = await Promise.all([
          cached(`assetLiquidity:${net.key}:${code}:${issuer || 'native'}`, TTL.LIVE, () =>
            isNative
              ? fetchOrderBookDepth(horizon, null, NATIVE_REFERENCE_ASSET)
              : fetchOrderBookDepth(horizon, asset, null)
          ).catch(() => null),
          !isNative && domain
            ? cached(`assetName:${net.key}:${code}:${issuer}:${domain}`, TTL.FINALIZED, () =>
                fetchTomlAssetName(domain, code, issuer)
              ).catch(() => null)
            : Promise.resolve(null),
          cached(`assetVolume:${net.key}:${code}:${issuer || 'native'}:${window}`, TTL.RECENT, () =>
            isNative
              ? fetchWindowVolume(horizon, NATIVE_REFERENCE_ASSET, null, window)
              : fetchWindowVolume(horizon, null, asset, window)
          ).catch(() => null),
        ]);
        results[key] = { liquidity, name, volume };
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, parsed.length) || 1 }, worker));

    res.json(results);
  } catch (err) {
    next(err);
  }
});

// Native-vs-asset price & volume history, using Horizon's trade_aggregations —
// the one place in this API that supports real start/end time filtering natively.
router.get('/price-history', async (req, res, next) => {
  try {
    const { code, issuer, resolution } = req.query;
    if (!code || !/^[A-Za-z0-9]{1,12}$/.test(code)) {
      return res.status(400).json({ error: 'code must be 1-12 alphanumeric characters' });
    }
    if (!issuer || !ISSUER_RE.test(issuer)) {
      return res.status(400).json({ error: 'issuer must be a valid Stellar account id (G...)' });
    }
    const { start, end, startMs, endMs } = parseDateRange(req.query);

    const resolutionMs = resolution ? Number(resolution) : 86_400_000; // default: 1 day buckets
    if (!VALID_RESOLUTIONS_MS.includes(resolutionMs)) {
      return res.status(400).json({
        error: `resolution must be one of ${VALID_RESOLUTIONS_MS.join(', ')} (ms) — Horizon only accepts these`,
      });
    }

    const net = resolveNetwork(req.query.network);
    const horizon = makeHorizonClient(net.horizon);

    const cacheKey = `priceHistory:${net.key}:${code}:${issuer}:${start}:${end}:${resolutionMs}`;
    const data = await cached(cacheKey, ttlForRange(endMs), async () => {
      // trade_aggregations pages at up to 200 buckets/request — previously this
      // made exactly one call and returned whatever came back, with no signal to
      // the client if the real range needed more. Reachable in practice: at the
      // default 1-day resolution, any range over ~200 days (well within
      // MAX_RANGE_MS's ~366-day cap, and reachable via the manual date inputs on
      // this view) silently dropped the remainder.
      //
      // Unlike Horizon's cursor-based collections, trade_aggregations has real
      // start/end filtering, so (unlike rangeFetch.js's ledger-cursor chunking)
      // the full set of chunk windows is knowable up front from
      // startMs/endMs/resolutionMs — chunks don't depend on each other's
      // results, so they're fetched with a bounded-concurrency worker pool
      // instead of one-at-a-time, same total request count but far less
      // wall-clock time on wide ranges. RECORDS_CAP is a safety valve for
      // pathological combinations (e.g. 1-minute resolution over a
      // near-year-long range), not an expected ceiling for normal use.
      const PAGE_LIMIT = 200;
      const RECORDS_CAP = 5000;
      const chunkSpanMs = PAGE_LIMIT * resolutionMs;
      const chunkBounds = [];
      for (let chunkStart = startMs; chunkStart < endMs; chunkStart += chunkSpanMs) {
        chunkBounds.push([chunkStart, Math.min(chunkStart + chunkSpanMs, endMs)]);
      }
      // Each chunk yields at most PAGE_LIMIT records, so capping the number of
      // chunks claimed bounds both the returned size AND the actual number of
      // Horizon requests made — unlike a post-hoc array slice, this stops a
      // pathological combination (e.g. 1-minute resolution over a near-year
      // range, ~2,600 chunks) from firing thousands of requests just to throw
      // most of the results away. Same "cap chunks claimed, mark truncated if
      // any remain unclaimed" shape as rangeFetch.js's worker pool.
      const maxChunks = Math.ceil(RECORDS_CAP / PAGE_LIMIT);

      const chunkResults = new Array(chunkBounds.length);
      let nextChunk = 0;
      async function worker() {
        while (nextChunk < chunkBounds.length && nextChunk < maxChunks) {
          const i = nextChunk++;
          const [chunkStart, chunkEnd] = chunkBounds[i];
          const page = await horizon.get('/trade_aggregations', {
            base_asset_type: 'native',
            counter_asset_type: code.length > 4 ? 'credit_alphanum12' : 'credit_alphanum4',
            counter_asset_code: code,
            counter_asset_issuer: issuer,
            start_time: chunkStart,
            end_time: chunkEnd,
            resolution: resolutionMs,
            order: 'asc',
            limit: PAGE_LIMIT,
          });
          chunkResults[i] = page._embedded.records;
        }
      }
      const workerCount = Math.min(6, chunkBounds.length, maxChunks) || 1;
      await Promise.all(Array.from({ length: workerCount }, worker));

      const records = chunkResults.flat().filter(Boolean);
      let truncated = nextChunk < chunkBounds.length;
      if (records.length > RECORDS_CAP) {
        records.length = RECORDS_CAP;
        truncated = true;
      }

      return {
        truncated,
        records: records.map((r) => ({
          timestamp: Number(r.timestamp),
          tradeCount: r.trade_count,
          baseVolume: r.base_volume,
          counterVolume: r.counter_volume,
          avgPrice: Number(r.avg),
          high: Number(r.high),
          low: Number(r.low),
        })),
      };
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;

