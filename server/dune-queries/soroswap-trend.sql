-- Dune query for DUNE_SOROSWAP_TREND_QUERY_ID (see server/.env.example and
-- README.md's "Optional: Dune Analytics" section). Powers the Smart
-- Contracts page's "Soroswap usage over time" call-volume trend
-- (server/src/routes/contracts.js's /protocol-trend route).
--
-- Day-bucketed call-volume trend, split into InvokeContract vs. CreateContract
-- via `o.function` — this only answers "how often," not "what for" (see
-- soroswap-functions.sql for that). Scoped to Soroswap's Factory and Router,
-- the one protocol with verified-pure-Soroban addresses at the time this was
-- written. Query ID in use: 8359764.

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
