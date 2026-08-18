-- Dune query for DUNE_QUERY_ID (see server/.env.example and README.md's
-- "Optional: Dune Analytics" section). Powers the Smart Contracts page's
-- "All-time asset movement through contracts" stat
-- (server/src/routes/contracts.js's /all-time route).
--
-- All-time (since Soroban's Feb 2024 mainnet launch) total value moved
-- through contract calls — can't come from live Horizon/RPC scanning (would
-- mean paging ~13.5M ledgers). Query ID in use: 8351659.

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
