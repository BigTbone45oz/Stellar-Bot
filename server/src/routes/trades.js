import { Router } from 'express';
import { resolveNetwork } from '../config.js';
import { makeHorizonClient } from '../horizonClient.js';
import { cached, TTL } from '../cache.js';

const router = Router();
const ISSUER_RE = /^G[A-Z2-7]{55}$/;

// Most recent trades for an asset pair. For historical charting, the client
// reuses /api/assets/price-history (trade_aggregations) rather than duplicating
// that logic here.
router.get('/recent', async (req, res, next) => {
  try {
    const { code, issuer } = req.query;
    if (!code || !/^[A-Za-z0-9]{1,12}$/.test(code)) {
      return res.status(400).json({ error: 'code must be 1-12 alphanumeric characters' });
    }
    if (!issuer || !ISSUER_RE.test(issuer)) {
      return res.status(400).json({ error: 'issuer must be a valid Stellar account id (G...)' });
    }

    const net = resolveNetwork(req.query.network);
    const horizon = makeHorizonClient(net.horizon);

    const data = await cached(`recentTrades:${net.key}:${code}:${issuer}`, TTL.LIVE, async () => {
      const page = await horizon.get('/trades', {
        base_asset_type: 'native',
        counter_asset_type: code.length > 4 ? 'credit_alphanum12' : 'credit_alphanum4',
        counter_asset_code: code,
        counter_asset_issuer: issuer,
        order: 'desc',
        limit: 20,
      });

      return page._embedded.records.map((t) => ({
        id: t.id,
        ledgerCloseTime: t.ledger_close_time,
        baseAmount: t.base_amount,
        counterAmount: t.counter_amount,
        price: t.price ? Number(t.price.n) / Number(t.price.d) : null,
      }));
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
