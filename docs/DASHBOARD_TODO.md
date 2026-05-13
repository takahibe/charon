# Live Dashboard TODO

Goal: local/private live dashboard for Charon dry-run and later confirm/live monitoring. Keep it read-only first; no private keys or trade execution controls in v1.

## v1 — Read-only operator dashboard

- [ ] Add a small local web server (`src/dashboard/server.js`) bound to `127.0.0.1` by default.
- [ ] Add `/dashboard` HTML page with auto-refresh or server-sent events.
- [ ] Show bot status: PM2 uptime, trading mode, active strategy, last signal poll, GMGN status, LLM errors.
- [ ] Show current dry-run positions: mint, symbol, route, entry mcap, current mcap, PnL %, TP/SL/trailing state, age.
- [ ] Show recent entries/exits with reason and decision confidence.
- [ ] Show candidate funnel: signals seen, triggered, filtered, WATCH, BUY, entry rejected.
- [ ] Show filter rejection leaderboard over selectable windows.
- [ ] Show smart-money flow: recent GMGN smartmoney buys/sells, clustered mints, unique smart buyers, net buy USD.
- [ ] Show strategy performance by route, mcap bucket, holder bucket, smart_degen_count, rug/bundler/rat bands.
- [ ] Add links to GMGN token page and Solscan for every mint/tx.

## v2 — Analysis and replay

- [ ] Add historical replay view from SQLite.
- [ ] Compare strategy versions and settings against realized dry-run PnL.
- [ ] Plot equity curve and drawdown.
- [ ] Add candidate detail page with raw JSON, filters, LLM decision, smart wallet cluster, and chart snapshots.
- [ ] Add export to CSV/JSON for offline analysis.

## v3 — Controlled ops

- [ ] Add password or Tailscale-only access before any remote exposure.
- [ ] Add read-only Telegram deep links for approve/reject if confirm mode is active.
- [ ] Add config editor only after audit logging and backup/rollback are implemented.
- [ ] Never expose `.env`, private keys, API keys, or wallet seed material.

## Security notes

- Dashboard must default to localhost only.
- If exposed remotely, put it behind Tailscale/Cloudflare Access/VPN, not raw public HTTP.
- v1 must be read-only. Trade buttons wait until confirm/live safety is proven.
