import { Router } from 'express';
import { resolveNetwork } from '../config.js';
import { makeHorizonClient } from '../horizonClient.js';
import { cached, TTL, ttlForRange } from '../cache.js';
import { parseDateRange } from '../validate.js';
import { STELLAR_EXPERT_NETWORK } from '../ledgerTime.js';
import { STELLAR_EXPERT_URL } from '../config.js';
import { fetchJsonOrThrow, fetchTextOrNull } from '../fetchWithTimeout.js';
import { runWorkerPool } from '../workerPool.js';

const router = Router();
const ISSUER_RE = /^G[A-Z2-7]{55}$/;
const ASSET_ID_RE = new RegExp(`^(.+)-(${ISSUER_RE.source.slice(1, -1)})-\\d+$`);
const VALID_RESOLUTIONS_MS = [60_000, 300_000, 900_000, 3_600_000, 86_400_000, 604_800_000];

// Horizon has no "top assets" ranking (no sort param on /assets at all).
// StellarExpert's asset list, sorted by its composite `rating`, is the only
// source for this — unlike ledgerTime.js's use of StellarExpert, there's no
// Horizon fallback possible here since the capability doesn't exist upstream.
const TOP_ASSETS_PAGE_SIZE = 50; // StellarExpert silently clamps `limit` to 50

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
// A regex parse (not a full TOML parser) is fine — only one string value out
// of one matching block is needed, not general TOML fidelity.
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

// XLM can't be paired against itself, so order_book/trade_aggregations (which
// need two distinct assets) don't work for native the way they do for every
// other asset here. Its liquidity/volume are computed against this single
// reference pair instead — Circle's canonical USDC issuer, XLM's deepest
// market. Known limitation: captures XLM/USDC activity only, not XLM's
// combined liquidity/volume across every pair it trades in.
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

// Sum of outstanding DEX order-book depth (bids + asks) for a sellingAsset/
// buyingAsset pair, denominated in sellingAsset units — the closest analogue
// Stellar has to "open interest" for a spot-only DEX. Every non-native asset
// sells itself for native, so depth comes back in its own units; the native
// row inverts this (see NATIVE_REFERENCE_ASSET), selling native for the
// reference asset so depth comes back in native/XLM units too. Order-book
// offers only, not AMM liquidity-pool reserves.
async function fetchOrderBookDepth(horizon, sellingAsset, buyingAsset) {
  const page = await horizon.get('/order_book', {
    ...assetParams('selling', sellingAsset),
    ...assetParams('buying', buyingAsset),
    limit: 200,
  });
  const sum = (levels) => levels.reduce((acc, l) => acc + Number(l.amount), 0);
  return sum(page.bids) + sum(page.asks);
}

// Deliberately NOT using StellarExpert's `volume7d` here, even for the '7d'
// option — it reads ~50x larger than trade_aggregations for the same window
// (likely including payments/off-DEX activity, not just SDEX+AMM trades).
// Blending it with a Horizon-computed 1h/1d/30d would make the numbers
// incomparable across window choices, so all windows go through Horizon.
const WINDOW_MS = { '1h': 3_600_000, '1d': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
// Resolution must be strictly smaller than the window, not equal — Horizon's
// buckets are clock-aligned (to the hour/day), not rolling, so a "last 1
// hour" query with a 1h bucket almost always lands entirely inside the
// still-forming current hour (zero completed buckets). A finer resolution
// means only a small sliver at each edge of the window can be missed,
// instead of the whole window reading as a false zero.
const RESOLUTION_FOR_WINDOW = { '1h': 300_000, '1d': 3_600_000, '7d': 86_400_000, '30d': 86_400_000 };

// Horizon amount fields (base_volume/counter_volume) are already decimal
// strings, unlike StellarExpert's raw-stroop `supply`/`volume7d` — no
// BigInt/1e7 conversion needed here (contrast with /top's supply handling).
//
// Returns volume denominated in counterAsset's units — every non-native call
// puts the target asset in the counter slot (base=native); the native row
// inverts this (base=reference, counter=native) so XLM's volume also comes
// back in native/XLM units.
async function fetchWindowVolume(horizon, baseAsset, counterAsset, window) {
  const endMs = Date.now();
  const startMs = endMs - WINDOW_MS[window];
  const resolutionMs = RESOLUTION_FOR_WINDOW[window]; // must be one of VALID_RESOLUTIONS_MS (top of file)
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

// Top 100 assets network-wide, ranked by StellarExpert's composite `rating`
// (age, activity, trustline count, liquidity, 7-day volume, interop). No
// Horizon equivalent exists — see the note above TOP_ASSETS_PAGE_SIZE.
router.get('/top', async (req, res, next) => {
  try {
    const net = resolveNetwork(req.query.network);
    const expertNetwork = STELLAR_EXPERT_NETWORK[net.key];
    if (!expertNetwork) {
      return res.status(400).json({ error: `Top-assets ranking isn't available for network "${net.key}"` });
    }

    const data = await cached(`topAssets:${net.key}`, TTL.RECENT, async () => {
      // Two pages of 50 cover the requested top 100. StellarExpert's cursor
      // is a plain offset, so both pages are independently fetchable without
      // waiting on page 1's response to know page 2's cursor.
      const [page1, page2] = await Promise.all([
        fetchStellarExpertAssetPage(expertNetwork, 0),
        fetchStellarExpertAssetPage(expertNetwork, TOP_ASSETS_PAGE_SIZE),
      ]);

      const records = [...(page1._embedded?.records || []), ...(page2._embedded?.records || [])];

      // Deduped by asset id — the two pages are fetched concurrently (see
      // above) against a live, rating-sorted list, so an asset that crosses
      // the page-50 boundary between the two requests could appear in both.
      const seenAssetIds = new Set();

      // rank is assigned AFTER filtering unparseable entries (below), not
      // from this map's index — otherwise the displayed ranking would have
      // gaps (1, 2, 4, 5…) whenever an entry gets dropped, while the client
      // still labels it "Top 100" and renders `rank` as-is.
      return records
        .map((r) => {
          if (seenAssetIds.has(r.asset)) return null;
          seenAssetIds.add(r.asset);
          const parsed = parseAssetId(r.asset);
          if (!parsed) return null;

          // `price` is USD, not XLM — named priceUsd so it isn't confused
          // with the XLM-denominated price-history route below.
          const priceUsd = r.price ?? null;

          // Ledger amounts (`supply`) are fixed-point int64 stroops (7
          // decimals) — same magnitude problem as TOID values in toid.js:
          // XLM's raw supply exceeds Number.MAX_SAFE_INTEGER, so
          // Number(r.supply) would silently round before dividing. BigInt
          // keeps it exact; the whole-unit result is small enough for a
          // plain JS number.
          let supply = null;
          if (typeof r.supply === 'string') {
            const stroops = BigInt(r.supply);
            const whole = stroops / 10_000_000n;
            const frac = stroops % 10_000_000n;
            supply = Number(whole) + Number(frac) / 1e7;
          }

          return {
            ...parsed,
            // tomlInfo.name (SEP-1 stellar.toml) only covers assets whose
            // issuer both sets home_domain and publishes a matching
            // CURRENCIES entry — most don't, so this falls back to the code.
            // /details fills in a real name lazily, per visible page.
            name: r.tomlInfo?.name || parsed.code,
            // This list endpoint's compact `trustlines` array is
            // [total, authorized, funded]. "Holders" means accounts actually
            // holding a balance (funded, trustlines[2]), not just anyone who
            // ever opened a trustline (trustlines[0]) — those can differ by
            // an order of magnitude for assets claimed and never used.
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

// Per-asset detail lazily fetched only for the currently visible page of the
// top-100 table (never all 100 at once) — real display name, live order-book
// depth, and (optionally) a custom-window trading volume. Each needs its own
// upstream call per asset, unlike /top's single shared StellarExpert list
// request, so this is deliberately opt-in/bounded rather than folded in.
//
// `assets` query param: comma-separated `CODE:ISSUER:DOMAIN` triples
// (ISSUER/DOMAIN may be empty — native XLM has neither; see
// NATIVE_REFERENCE_ASSET above. Name lookup is skipped for native and for
// any issuer with no known home domain).
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
    // Bounded-concurrency worker pool — independent per-asset work, no
    // reason to serialize it.
    await runWorkerPool(parsed, 6, async ({ code, issuer, domain, key, isNative }) => {
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
    });

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
      // trade_aggregations pages at up to 200 buckets/request. Unlike
      // Horizon's cursor-based collections, it supports real start/end
      // filtering, so the full set of chunk windows is knowable up front from
      // startMs/endMs/resolutionMs — chunks don't depend on each other and
      // are fetched with a bounded-concurrency worker pool. RECORDS_CAP is a
      // safety valve for pathological combinations (e.g. 1-minute resolution
      // over a near-year-long range), not an expected ceiling.
      const PAGE_LIMIT = 200;
      const RECORDS_CAP = 5000;
      const chunkSpanMs = PAGE_LIMIT * resolutionMs;
      const chunkBounds = [];
      for (let chunkStart = startMs; chunkStart < endMs; chunkStart += chunkSpanMs) {
        chunkBounds.push([chunkStart, Math.min(chunkStart + chunkSpanMs, endMs)]);
      }
      // Each chunk yields at most PAGE_LIMIT records, so capping the number
      // of chunks claimed bounds both the returned size and the actual
      // number of Horizon requests made, instead of firing them all and
      // throwing most away via a post-hoc slice. Unlike rangeFetch.js's cap
      // (which depends on per-chunk record counts only known at fetch time),
      // maxChunks here is computed from constants alone, so which chunks will
      // ever be fetched is knowable up front — pre-sliced and run through the
      // shared worker pool rather than a bespoke early-stop loop.
      const maxChunks = Math.ceil(RECORDS_CAP / PAGE_LIMIT);
      const boundedChunks = chunkBounds.slice(0, maxChunks);

      const chunkResults = new Array(boundedChunks.length);
      await runWorkerPool(boundedChunks, 6, async ([chunkStart, chunkEnd], i) => {
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
      });

      const records = chunkResults.flat().filter(Boolean);
      let truncated = boundedChunks.length < chunkBounds.length;
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

