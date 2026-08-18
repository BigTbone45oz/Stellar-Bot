-- Dune query for DUNE_ACCOUNT_GROWTH_QUERY_ID (see server/.env.example and
-- README.md's "Optional: Dune Analytics" section). Powers the Network Growth
-- page's "All-time trend" section (server/src/routes/growth.js's
-- /account-trend route).
--
-- Day-bucketed account creation vs. closure (account_merge) counts, since
-- Stellar's 2015 launch. Can't come from live Horizon: payments.js's
-- /breakdown route (which enumerates raw /operations) hits its 20,000-op
-- safety cap within hours on pubnet, nowhere near enough for a real
-- multi-month trend, and Horizon has no aggregate "op type X per day"
-- endpoint. Query ID in use: 8363713.

select
  o.closed_at_date as day,
  sum(case when o.type_string = 'create_account' then 1 else 0 end) as accounts_created,
  sum(case when o.type_string = 'account_merge' then 1 else 0 end) as accounts_merged
from stellar.history_operations o
where o.type_string in ('create_account', 'account_merge')
group by 1
order by 1
