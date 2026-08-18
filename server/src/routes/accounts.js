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
        // Horizon's /payments collection also includes account_merge records
        // (per Horizon's own docs) — those have no amount/asset_type/asset_code
        // on the operation record at all (a merge moves the account's entire
        // remaining balance, only visible via effects, not this endpoint), so
        // mapping one straight through would render as a misleading "XLM"
        // payment with a blank/NaN amount. Filtered out here, matching
        // payments.js's own PAYMENT_OP_TYPES, which deliberately excludes it
        // from "payment volume" for the same reason.
        recentPayments: payPage._embedded.records
          .filter((p) => p.type !== 'account_merge')
          .map((p) => ({
            id: p.id, // the operation's own id — unique per record, unlike transactionHash
                      // (a single transaction can contain multiple payment operations)
            type: p.type,
            from: p.from,
            to: p.to,
            amount: p.amount,
            assetType: p.asset_type,
            assetCode: p.asset_code,
            // Two different assets can share the same code under different
            // issuers (the exact ambiguity assets.js's /top numAccounts and
            // payments.js's swap legs already account for) — without the
            // issuer, a payment in a shared code (real or a look-alike scam
            // token) is indistinguishable from the legitimate asset.
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
