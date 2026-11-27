# Token Radar

[![token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Brilliancoder/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Brilliancoder/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01)

make.fun entry for **token-radar-01**: the best token launch radar. It reads a sealed DefiLlama snapshot (758 protocols), finds the ones with no token yet, ranks them by an implied launch value, and shows a dashboard with the board, a detail view for every protocol, and a concrete farm plan for each row.

- `main.ts` (Node 22, stdlib only) reads the snapshot at `/input/snapshot.json`, writes the ranked board to `/output/board.json` (178 rows: all 40 watchlist protocols plus 138 below the floor), writes the dashboard data, copies `dashboard/` and `screenshots/`, and writes `/output/dossier.json` with `buildDossier` from `vendor/makefun-board.ts`.
- The value model derives each protocol's implied value from the snapshot's own figures: TVL, seven-day TVL change, and days listed with no token. Each category gets a multiple from the market-cap-to-TVL ratios of protocols in it whose token already trades. No hardcoded list of names.
- Every row carries 7 farm steps with costs and times, based on the protocol's category and cheapest chain.
- The dashboard is a static page with no network: sortable board, five filters, a detail view per protocol, a Model tab showing the formula and each category's multiple.

Local run: `MAKEFUN_OUTPUT_DIR=out node main.ts --input snapshot-local.json` (snapshot copy for local runs only; grading reads `/input/snapshot.json`).
