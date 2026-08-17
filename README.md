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

## Setup

Requires Node 18+ (for native `fetch`).

```bash
npm run install:all
cp server/.env.example server/.env
npm run dev
```

This starts:
- `server/` on http://localhost:8787 (Express API, proxies Horizon + Soroban RPC)
- `client/` on http://localhost:5173 (Vite + React, proxies /api to the server)

Open http://localhost:5173.

The app works with `server/.env` completely empty (every value has a public-endpoint
default baked into `server/src/config.js`) — you only need to fill in the optional
keys below if you want the two features backed by them.

### Optional: Dune Analytics (all-time Soroban stats)

Without this, the Smart Contracts page's "all-time asset movement" and "Soroswap
usage over time" sections just show as unavailable — everything else works fine.

1. Free account at [dune.com](https://dune.com), then an API key from your account
   settings → `DUNE_API_KEY` in `server/.env`.
2. In Dune's query editor (Dune SQL engine), save this query for the all-time
   asset-movement stat, then put its numeric query ID in `DUNE_QUERY_ID`:
   ```sql
   select
     coalesce(e.asset_code, 'XLM') as asset_code,
     e.asset_issuer,
     sum(e.amount) as total_amount,
     count(*) as effect_count
   from stellar.history_operations o
   join stellar.history_effects e on e.operation_id = o.id
   where o.type_string = 'invoke_host_function'
     and e.type_string in ('account_credited', 'trustline_credited')
   group by 1, 2
   order by total_amount desc
   limit 200
   ```
3. Optionally, also save this one for the Soroswap call-volume trend, and put its
   ID in `DUNE_SOROSWAP_TREND_QUERY_ID`:
   ```sql
   select
     o.closed_at_date as day,
     o.function,
     count(*) as call_count
   from stellar.history_operations o
   where o.type_string = 'invoke_host_function'
     and o.contract_id in (
       'CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2', -- Soroswap Factory
       'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH'  -- Soroswap Router
     )
   group by 1, 2
   order by 1
   ```

Both routes only ever read a saved query's latest cached result (free, no fresh
execution triggered), cached server-side for hours — this won't burn through
Dune's free-tier credits under normal use.

### Optional: nothing else needed for DeFiLlama

The Protocols page (on-chain protocol rankings, trading volume trends) uses
DeFiLlama's public API directly — free, no API key, nothing to configure.

## Project layout

```
server/                  Express API — the only thing that talks to Horizon/Soroban RPC
                          (plus DeFiLlama and Dune — see "Setup" above)
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
                          for stable cache keys, and caps range width — see the code
                          comments for why)
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
                            and a Soroswap call-volume trend, both backed by Dune
      protocols.js           On-chain protocol ranking by volume/TVL, backed by
                            DeFiLlama

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

This project went through several full rounds of review before this commit —
checking correctness, efficiency, and every upstream API assumption against the
real Horizon/Soroban RPC/Dune/DeFiLlama responses, not just re-reading the code.
Real bugs were found and fixed each round; a fair number of them were only
reachable through actual usage (date-math edge cases, cache-key gaps, response
fields nobody was reading), which is why the code comments in this repo tend to
explain *why* something is written a specific way, not just what it does — that
context is usually the record of a bug that shape of code was written to avoid.

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
