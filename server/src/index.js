import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { PORT } from './config.js';

import networkRoutes from './routes/network.js';
import ledgerRoutes from './routes/ledgers.js';
import paymentRoutes from './routes/payments.js';
import accountRoutes from './routes/accounts.js';
import assetRoutes from './routes/assets.js';
import tradeRoutes from './routes/trades.js';
import contractRoutes from './routes/contracts.js';
import protocolRoutes from './routes/protocols.js';
import growthRoutes from './routes/growth.js';

const app = express();

app.use(cors());
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120, // generous for a single local user, protects against runaway loops
    standardHeaders: true,
    legacyHeaders: false,
    // Match the JSON error shape every other route in this API uses, rather than
    // express-rate-limit's plain-text default.
    handler: (req, res) => {
      res.status(429).json({ error: 'Too many requests — wait a moment and try again' });
    },
  })
);

// Every route below is an explicit, whitelisted, read-only endpoint —
// deliberately NOT a generic pass-through proxy to Horizon/Soroban RPC.
app.use('/api/network', networkRoutes);
app.use('/api/ledgers', ledgerRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/trades', tradeRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/protocols', protocolRoutes);
app.use('/api/growth', growthRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api', (req, res) => {
  res.status(404).json({ error: `No such route: ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, () => {
  console.log(`Stellar dashboard API listening on http://localhost:${PORT}`);
});
