# Stellar Dashboard

A local dashboard for exploring Stellar network data: ledgers/transactions, accounts,
assets, DEX trades, and Soroban smart contract activity — each with its own date range,
across mainnet or testnet.

## Why a backend proxy

Public Soroban RPC nodes have inconsistent CORS support and tight rate limits, and Horizon
has no native date-range filtering for ledgers/transactions (only cursor paging). The
`server/` here does the jobs the browser shouldn't: resolves timestamps to ledger sequences
(via StellarExpert's API, with a binary-search-against-Horizon fallback), fetches wide date
ranges as parallel chunked requests instead of one long sequential cursor-walk, aggregates
raw records into chart-ready summaries, and caches finalized (immutable) historical data so
repeat requests are instant.

## Running it

Requires Node 18+ (for native `fetch`).

```bash
npm run install:all
npm run dev
```

This starts:
- `server/` on http://localhost:8787 (Express API, proxies Horizon + Soroban RPC)
- `client/` on http://localhost:5173 (Vite + React, proxies /api to the server)

Open http://localhost:5173.

## Project layout

```
server/                  Express API — the only thing that talks to Horizon/Soroban RPC
                          (plus DeFiLlama and Dune — see CLAUDE.md's third-party data section)
  src/
    config.js            Mainnet + testnet endpoint pairs, tunable via .env
    cache.js             In-memory TTL cache (long TTL for finalized history, short for live data)
    ledgerTime.js         Timestamp -> ledger sequence: StellarExpert API first, binary
                          search against Horizon as fallback if that's unavailable
    rangeFetch.js          Parallel chunked pagination across a known ledger-sequence
                          range (used instead of sequential cursor-walking)
    horizonClient.js      Thin fetch wrapper for Horizon REST
    sorobanClient.js       Thin fetch wrapper for Soroban JSON-RPC
    duneClient.js           Thin fetch wrapper for Dune's "get latest query result" API
    assetPricing.js         Shared StellarExpert USD-price lookup (used by payments.js
                          and contracts.js)
    httpError.js            Shared "Error with an HTTP status attached" constructor
    validate.js             Date-range parsing/validation (also floors to the minute
                          for stable cache keys — see CLAUDE.md)
    routes/
      network.js          Live network stats + recent ledger stream
      ledgers.js          Ledger/tx volume over a date range (from /ledgers, not raw txs)
      payments.js         Operation-type breakdown over a date range (aggregated + cached)
      accounts.js          Account lookup: balances + recent activity
      assets.js            Top-100 ranking, asset search, and trade_aggregations
                          price/volume history
      trades.js            DEX trade history
      contracts.js          Soroban contract events (RPC, ~7-day retention) with
                            automatic fallback to Horizon invoke_host_function ops
                            for older ranges, plus an all-time asset-movement stat
                            backed by Dune (see CLAUDE.md)
      protocols.js           On-chain protocol ranking by volume/TVL, backed by
                            DeFiLlama (see CLAUDE.md)

client/                  React + Vite
  src/
    api.js                Fetch wrapper + one function per server route
    dateUtils.js            Shared date-math/range-preset helpers (all views)
    opTypes.js               Horizon operation-type / host-function-type labels+descriptions
    contractFunctions.js      Heuristic descriptions for common Soroban contract function names
    components/          NetworkToggle, DateRangePicker, ChartPanel, StatCard, Tabs
    views/                One file per tab — Overview, Assets, SmartContracts, Protocols,
                          LedgersTransactions, PaymentsOperations, Accounts, Trades
```

## Review history

This project went through repeated rounds of self-review (see `CLAUDE.md` for the
full log and the process itself) — real bugs were found and fixed, not just
architecture polish. If you're modifying this code, read `CLAUDE.md` first; it has
verified facts about Horizon/Soroban RPC behavior that took real research to pin
down, and a list of what's already been fixed so it isn't accidentally reintroduced.

## Notes / known limits

- **Testnet history is shallow.** SDF periodically resets testnet, so a "last 6 months"
  query there may just come up empty. The network toggle shows a small note when this
  applies.
- **Contract event detail only goes back ~7 days** on public Soroban RPC. Older ranges
  automatically fall back to Horizon's `invoke_host_function` operations, which show
  *that* a contract was invoked but not decoded event data. The UI labels which mode
  it's in.
- **No write access anywhere.** Every route is read-only; nothing here ever asks for or
  handles a secret key.
- If you outgrow the public rate limits, set `HORIZON_PUBNET_URL` / `SOROBAN_PUBNET_RPC`
  in `server/.env` to a paid provider (e.g. a dedicated Horizon or Soroban RPC endpoint) —
  the client code doesn't need to change.
