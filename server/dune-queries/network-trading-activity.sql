-- Dune query for DUNE_NETWORK_TRADES_QUERY_ID (see server/.env.example and
-- README.md's "Optional: Dune Analytics" section). Powers the Smart
-- Contracts page's "Trading activity across all Soroban contracts" section
-- (server/src/routes/contracts.js's /network-trading-activity route).
--
-- Network-wide (every Soroban contract, not just a known protocol) function
-- breakdown of real detected trades — the "moved 2+ distinct assets in one
-- operation" test is a provable trade signal, not a name-based guess (same
-- logic payments.js uses live for a date range; this runs it via Dune against
-- full history instead). NOT protocol-labeled (no network-wide mapping from
-- contract_id to protocol name — see protocol-functions.sql for the labeled,
-- but narrower, version). Raw function names include real noise: cryptic 1-2
-- char names (filtered server-side, <3% of matched calls) and at least one
-- joke name ("yeet", the single most-called function in the raw data).
--
-- HEAVY QUERY — took ~19 minutes to execute (full-history join, no contract
-- scope), unlike the Soroswap-scoped queries above which run in ~2-3 minutes.
-- Query ID in use: 8362776.

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
