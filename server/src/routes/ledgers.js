import { Router } from 'express';
import { resolveNetwork } from '../config.js';
import { makeHorizonClient } from '../horizonClient.js';
import { ledgerSequenceForTimestamp } from '../ledgerTime.js';
import { cached, ttlForRange } from '../cache.js';
import { fetchRangeParallel } from '../rangeFetch.js';
import { parseDateRange } from '../validate.js';

const router = Router();

// Chart data source is /ledgers (has per-ledger tx/op counts already) rather than
// fetching every transaction — orders of magnitude fewer requests for the same chart.
router.get('/volume', async (req, res, next) => {
  try {
    const { start, end, endMs } = parseDateRange(req.query);
    const net = resolveNetwork(req.query.network);
    const horizon = makeHorizonClient(net.horizon);

    const cacheKey = `ledgerVolume:${net.key}:${start}:${end}`;
    const data = await cached(cacheKey, ttlForRange(endMs), async () => {
      const [startSeq, endSeq] = await Promise.all([
        ledgerSequenceForTimestamp(horizon, net.key, start),
        ledgerSequenceForTimestamp(horizon, net.key, end),
      ]);

      const byDay = new Map(); // 'YYYY-MM-DD' -> { transactions, operations, ledgers }

      // /ledgers has exactly one record per ledger, so a 200-ledger chunk maps
      // to exactly one Horizon page — chunks fetch in parallel.
      const { truncated } = await fetchRangeParallel(horizon, '/ledgers', startSeq, endSeq, {
        ledgersPerChunk: 200,
        // Safety cap, not a hard technical limit — ledgers close every ~5s, so
        // this is ~7.9 days of pubnet history, matching the widest client
        // preset (7d, see LedgersTransactions.jsx). Not raised further without
        // also adding retry/backoff for Horizon's 429 rate-limiting
        // (horizonClient.js currently has none) — a much wider range risks a
        // hard failure mid-fetch instead of a graceful truncation.
        maxRecords: 130_000,
        onPage: (records) => {
          for (const l of records) {
            const day = l.closed_at.slice(0, 10);
            const bucket = byDay.get(day) || { date: day, transactions: 0, operations: 0, ledgers: 0 };
            bucket.transactions += l.successful_transaction_count;
            bucket.operations += l.operation_count;
            bucket.ledgers += 1;
            byDay.set(day, bucket);
          }
        },
      });

      return {
        startSeq,
        endSeq,
        truncated,
        buckets: Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date)),
      };
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
