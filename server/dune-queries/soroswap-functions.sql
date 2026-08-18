-- Dune query for DUNE_SOROSWAP_FUNCTIONS_QUERY_ID (see server/.env.example
-- and README.md's "Optional: Dune Analytics" section). Powers the Smart
-- Contracts page's real per-function breakdown for Soroswap
-- (server/src/routes/contracts.js's /protocol-trend route, functionTotals/
-- dailyByFunction fields).
--
-- The actual "what are they calling it for" answer (swap vs. add/remove
-- liquidity, etc.) — decoded from Dune's `parameters_decoded`, not a guess.
-- `parameters_decoded` is array(ROW("type" varchar, "value" varchar));
-- index 2's `.value` holds the invoked function's Symbol, per
-- InvokeContractArgs' fixed struct field order (contractAddress,
-- functionName, args) — same fact server/src/routes/payments.js's own
-- decodeInvokedFunctionName relies on for raw XDR, just decoded by Dune
-- instead. Query ID in use: 8361847.

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
