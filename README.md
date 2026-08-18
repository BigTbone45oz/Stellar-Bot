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
4. Optionally, also save this one for the real per-function breakdown (what
   Soroswap is actually being called to do — swap vs. add/remove liquidity, etc.,
   decoded from Dune's `parameters_decoded`, not a guess), and put its ID in
   `DUNE_SOROSWAP_FUNCTIONS_QUERY_ID`:
   ```sql
   select
     o.closed_at_date as day,
     element_at(o.parameters_decoded, 2).value as function_name,
     count(*) as call_count
   from stellar.history_operations o
   where o.type_string = 'invoke_host_function'
     and o.function = 'HostFunctionTypeHostFunctionTypeInvokeContract'
     and o.contract_id in (
       'CA4HEQTL2WPEUYKYKCDOHCDNIV4QHNJ7EL4J4NQ6VADP7SYHVRYZ7AW2', -- Soroswap Factory
       'CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH'  -- Soroswap Router
     )
   group by 1, 2
   order by 1
   ```
5. Optionally, also save this one for a network-wide trading breakdown (every
   Soroban contract, not just Soroswap — real detected trades only, via the
   same "moved 2+ distinct assets" test used elsewhere in this app), and put
   its ID in `DUNE_NETWORK_TRADES_QUERY_ID`. **This one is heavy — expect
   roughly 15-20 minutes to actually execute** (a full-history join with no
   contract scope), unlike the others above which run in a couple of minutes:
   ```sql
   with swap_ops as (
     select operation_id
     from stellar.history_effects
     where type_string in ('account_credited', 'trustline_credited')
     group by operation_id
     having count(distinct coalesce(asset_code, 'XLM') || ':' || coalesce(asset_issuer, '')) >= 2
   )
   select
     o.closed_at_date as day,
     element_at(o.parameters_decoded, 2).value as function_name,
     count(*) as call_count
   from stellar.history_operations o
   join swap_ops s on s.operation_id = o.id
   where o.type_string = 'invoke_host_function'
     and o.function = 'HostFunctionTypeHostFunctionTypeInvokeContract'
   group by 1, 2
   order by 1
   ```
   Since this isn't scoped to a known protocol, results aren't labeled by which
   protocol they belong to, and the raw function names include some noise —
   see `CLAUDE.md`'s "Third-party data integrations" section (if you have it
   locally — it's not tracked in this repo) or the code comments in
   `contracts.js`'s `/network-trading-activity` route for the details.
6. Optionally, also save this one for the Network Growth page's all-time
   account creation/closure trend, and put its ID in `DUNE_ACCOUNT_GROWTH_QUERY_ID`:
   ```sql
   select
     o.closed_at_date as day,
     sum(case when o.type_string = 'create_account' then 1 else 0 end) as accounts_created,
     sum(case when o.type_string = 'account_merge' then 1 else 0 end) as accounts_merged
   from stellar.history_operations o
   where o.type_string in ('create_account', 'account_merge')
   group by 1
   order by 1
   ```
7. Optionally, also save this one for the Network Growth page's per-asset
   trustline breakdown, and put its ID in `DUNE_TRUSTLINE_GROWTH_QUERY_ID`:
   ```sql
   select
     o.asset_code,
     o.asset_issuer,
     count(*) as trustline_changes
   from stellar.history_operations o
   where o.type_string = 'change_trust'
   group by 1, 2
   order by trustline_changes desc
   ```
   An earlier version of this query grouped by day too — it finished executing
   fine, but *reading* the result hit a Dune read-credit limit (402), because
   the day dimension multiplied the result set by ~3,950x for no reason this
   route actually needed (it only ever consumes all-time per-asset totals).
   Dropping `day` from the `GROUP BY` fixed both the cost and the size problem.
8. Optionally, also save this one for the Smart Contracts page's multi-protocol
   function-call breakdown (Soroswap, Sushi, Blend, Phoenix — not just
   Soroswap), and put its ID in `DUNE_PROTOCOL_FUNCTIONS_QUERY_ID`:
   ```sql
   with protocol_contracts (contract_id, protocol_name) as (
     values
       ('CA2TZIB56KYKD46F7IFBF6XPO5TDNK6N2U6BRTGZ5AF4WUSBN6BKZMGF', 'Soroswap'),
       -- ... 82 more Soroswap pool addresses
       ('CAG4F7ROIOYF67FDJVKYVVV3QLZTBVE76COFDORGYSHQYTBRCVMN7T5I', 'Sushi'),
       -- ... 23 more Sushi pool addresses
       ('CAE7QVOMBLZ53CDRGK3UNRRHG5EZ5NQA7HHTFASEMYBWHG6MDFZTYHXC', 'Blend'),
       -- ... 10 more Blend addresses (Pools, Pools V2, Backstop, Backstop V2, Emitter)
       ('CB5QUVK5GS3IU23TMFZQ3P5J24YBBZP5PHUQAEJ2SP5K55PFTJRUQG2L', 'Phoenix')
       -- ... 10 more Phoenix pool addresses
   )
   select
     pc.protocol_name,
     element_at(o.parameters_decoded, 2).value as function_name,
     count(*) as call_count
   from stellar.history_operations o
   join protocol_contracts pc on pc.contract_id = o.contract_id
   where o.type_string = 'invoke_host_function'
     and o.function = 'HostFunctionTypeHostFunctionTypeInvokeContract'
   group by 1, 2
   order by 1, call_count desc
   ```
   The full 129-address list (all four protocols' verified contract addresses,
   sourced from StellarExpert's Directory API — `api.stellar.expert/explorer/public/directory?tag[]=defi`,
   grouped by `domain`) is generated, not hand-typed — see CLAUDE.md's "Verified
   facts" section for how. Aquarius was deliberately excluded despite having the
   most directory-listed pool addresses (208) — sampled several live and found
   no recent activity on any of them, consistent with Aquarius still running
   mostly on Stellar's classic protocol-level DEX rather than Soroban contracts.

All eight routes only ever read a saved query's latest cached result (free, no
fresh execution triggered), cached server-side for hours — this won't burn
through Dune's free-tier credits under normal use.

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
      payments.js         Operation-type breakdown over a date range: op counts, contract-
                          caused asset movement, plain payment volume (USD), and network
                          growth (new accounts/trustlines) — all from one /operations pass,
                          aggregated + cached
      accounts.js          Account lookup: balances + recent activity
      assets.js            Top-100 ranking, asset search, and trade_aggregations
                          price/volume history
      trades.js            DEX trade history
      contracts.js          Soroban contract events (RPC, ~7-day retention) with
                            automatic fallback to Horizon invoke_host_function ops
                            for older ranges, plus an all-time asset-movement stat,
                            a Soroswap call-volume trend, network-wide trade-function
                            breakdown, and a multi-protocol function-call breakdown
                            (Soroswap/Sushi/Blend/Phoenix), all backed by Dune
      protocols.js           On-chain protocol ranking by volume/TVL, backed by
                            DeFiLlama
      growth.js               All-time account creation/closure trend and per-asset
                            trustline growth breakdown, both backed by Dune (live-
                            Horizon can't reach back far enough for a real trend)

client/                  React + Vite
  src/
    api.js                Fetch wrapper + one function per server route
    dateUtils.js            Shared date-math/range-preset helpers (all views)
    opTypes.js               Horizon operation-type / host-function-type labels+descriptions
    contractFunctions.js      Heuristic descriptions for common Soroban contract function names
    hooks/
      useAsyncResource.js     Fetch-with-guaranteed-reset — every fetch effect in this app
                              (auto-fetch-on-deps-change AND manual/click-triggered) goes
                              through this, so a new effect can't structurally omit the
                              "clear stale state before refetching" step the way over a
                              dozen hand-written effects independently forgot to before
                              this was extracted
      usePolledResource.js    Same guarantee, for the one polling case (Overview's
                              network-health stats — 30s interval + visibilitychange)
    components/          NetworkToggle, DateRangePicker, ChartPanel, StatCard, Tabs
    views/                One file per tab — Overview, Assets, SmartContracts, NetworkGrowth,
                          Protocols, LedgersTransactions, PaymentsOperations, Accounts, Trades
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
