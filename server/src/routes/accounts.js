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
      const [account, payPage] = await Promise.all([
        horizon.get(`/accounts/${id}`),
        horizon.get(`/accounts/${id}/payments`, { order: 'desc', limit: 10 }),
      ]);

      return {
        id: account.account_id,
        sequence: account.sequence,
        subentryCount: account.subentry_count,
        balances: account.balances,
        // account_merge records have no amount/asset_type/asset_code on the
        // operation itself (a merge moves the entire remaining balance,
        // visible only via effects) — mapping one through would render as a
        // misleading "XLM" payment with a blank/NaN amount, so it's filtered
        // out here, matching payments.js's PAYMENT_OP_TYPES exclusion.
        recentPayments: payPage._embedded.records
          .filter((p) => p.type !== 'account_merge')
          .map((p) => ({
            id: p.id, // operation's own id — unique per record, unlike transactionHash
            type: p.type,
            from: p.from,
            to: p.to,
            amount: p.amount,
            assetType: p.asset_type,
            assetCode: p.asset_code,
            // Different assets can share a code under different issuers
            // (including look-alike scam tokens) — issuer disambiguates.
            assetIssuer: p.asset_issuer,
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
