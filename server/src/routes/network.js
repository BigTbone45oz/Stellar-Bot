import { Router } from 'express';
import { resolveNetwork } from '../config.js';
import { makeHorizonClient } from '../horizonClient.js';
import { cached, TTL } from '../cache.js';

const router = Router();

router.get('/overview', async (req, res, next) => {
  try {
    const net = resolveNetwork(req.query.network);
    const horizon = makeHorizonClient(net.horizon);

    const data = await cached(`overview:${net.key}`, TTL.LIVE, async () => {
      const root = await horizon.get('/');
      return {
        latestLedger: root.history_latest_ledger,
        protocolVersion: root.current_protocol_version,
        horizonVersion: (root.horizon_version || '').split('-')[0],
        baseFeeStroops: root.base_fee_in_stroops,
        baseReserveStroops: root.base_reserve_in_stroops,
      };
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/recent-ledgers', async (req, res, next) => {
  try {
    const net = resolveNetwork(req.query.network);
    const horizon = makeHorizonClient(net.horizon);
    // Clamped both directions — 0/negative would otherwise pass straight to
    // Horizon and surface as a raw upstream error.
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);

    const data = await cached(`recentLedgers:${net.key}:${limit}`, TTL.LIVE, async () => {
      const page = await horizon.get('/ledgers', { order: 'desc', limit });
      return page._embedded.records.map((l) => ({
        sequence: l.sequence,
        closedAt: l.closed_at,
        transactionCount: l.successful_transaction_count,
        operationCount: l.operation_count,
      }));
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
