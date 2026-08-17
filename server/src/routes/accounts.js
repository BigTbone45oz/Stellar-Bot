import { Router } from 'express';
import { resolveNetwork } from '../config.js';
import { makeHorizonClient, HorizonError } from '../horizonClient.js';
import { TTL, cached } from '../cache.js';

const router = Router();
const PUBLIC_KEY_RE = /^G[A-Z2-7]{55}$/;

router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!PUBLIC_KEY_RE.test(id)) {
      return res.status(400).json({ error: 'Not a valid Stellar public key' });
    }

    const net = resolveNetwork(req.query.network);
    const horizon = makeHorizonClient(net.horizon);

    const data = await cached(`account:${net.key}:${id}`, TTL.LIVE, async () => {
      // Only balances + payments are fetched — a /transactions call used to be
      // made here too, but nothing in the client ever rendered the result. An
      // unused upstream fetch on every single account lookup is pure waste;
      // removed rather than left "just in case."
      const [account, payPage] = await Promise.all([
        horizon.get(`/accounts/${id}`),
        horizon.get(`/accounts/${id}/payments`, { order: 'desc', limit: 10 }),
      ]);

      return {
        id: account.account_id,
        sequence: account.sequence,
        subentryCount: account.subentry_count,
        balances: account.balances,
        recentPayments: payPage._embedded.records.map((p) => ({
          id: p.id, // the operation's own id — unique per record, unlike transactionHash
                    // (a single transaction can contain multiple payment operations)
          type: p.type,
          from: p.from,
          to: p.to,
          amount: p.amount,
          assetType: p.asset_type,
          assetCode: p.asset_code,
          createdAt: p.created_at,
          transactionHash: p.transaction_hash,
        })),
      };
    });

    res.json(data);
  } catch (err) {
    if (err instanceof HorizonError && err.status === 404) {
      return res.status(404).json({ error: 'Account not found on this network (it may not be funded yet)' });
    }
    next(err);
  }
});

export default router;
