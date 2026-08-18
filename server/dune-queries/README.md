# Dune queries

The saved-query SQL behind every `DUNE_*_QUERY_ID` in `server/.env.example`.
These are also inlined in the root `README.md`'s "Optional: Dune Analytics"
setup section — kept here too as copy-pasteable files (and so the per-query
reasoning/history has a home that isn't a giant markdown wall).

To use one: paste its contents into a new Dune SQL query at
[dune.com](https://dune.com), run it, save it, and put its numeric query ID
in the matching `DUNE_*_QUERY_ID` variable in `server/.env`.

| File | Env var | Powers |
|---|---|---|
| `all-time-asset-movement.sql` | `DUNE_QUERY_ID` | Smart Contracts — all-time asset movement |
| `soroswap-trend.sql` | `DUNE_SOROSWAP_TREND_QUERY_ID` | Smart Contracts — Soroswap call-volume trend |
| `soroswap-functions.sql` | `DUNE_SOROSWAP_FUNCTIONS_QUERY_ID` | Smart Contracts — Soroswap per-function breakdown |
| `network-trading-activity.sql` | `DUNE_NETWORK_TRADES_QUERY_ID` | Smart Contracts — network-wide trade-function breakdown |
| `account-growth-trend.sql` | `DUNE_ACCOUNT_GROWTH_QUERY_ID` | Network Growth — account creation/closure trend |
| `trustline-growth-by-asset.sql` | `DUNE_TRUSTLINE_GROWTH_QUERY_ID` | Network Growth — per-asset trustline breakdown |
| `protocol-functions.sql` | `DUNE_PROTOCOL_FUNCTIONS_QUERY_ID` | Smart Contracts — multi-protocol function-call breakdown |

None of this is secret — contract addresses and SQL are public information.
`DUNE_API_KEY` itself still only ever lives in the gitignored `server/.env`.
