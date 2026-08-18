-- Dune query for DUNE_TRUSTLINE_GROWTH_QUERY_ID (see server/.env.example and
-- README.md's "Optional: Dune Analytics" section). Powers the Network Growth
-- page's "Trustline growth by asset, all time" section
-- (server/src/routes/growth.js's /trustline-trend route).
--
-- Which specific assets are actually gaining trustline activity, all-time —
-- same "can't come from live Horizon" reasoning as account-growth-trend.sql.
-- Query ID in use: 8363720.
--
-- NOT grouped by day: an earlier version did (`group by 1, 2, 3` with
-- `o.closed_at_date as day`), which finished executing fine but *reading* the
-- result hit a Dune read-credit limit (402 "would exceed your configured
-- credits limit for read requests") — the day dimension multiplied the
-- result set by ~3,950x (days since 2015) for no reason growth.js's route
-- actually needed (it only ever consumes all-time per-asset totals, see
-- assetTotals in that route). Dropping `day` from the GROUP BY fixed both
-- the cost and the result-set-size problem in one move. Worth remembering
-- generally: Dune read-credit cost scales with result-set size, not just
-- query complexity — check whether every GROUP BY dimension is actually
-- consumed downstream before assuming it's free just because the query runs
-- fast.

select
  o.asset_code,
  o.asset_issuer,
  count(*) as trustline_changes
from stellar.history_operations o
where o.type_string = 'change_trust'
group by 1, 2
order by trustline_changes desc
