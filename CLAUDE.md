# Charon — Solana Microcap Trading Bot

A Node.js Telegram bot that finds and trades early-stage tokens on Pump.fun and Meteora DBC (Dynamic Bonding Curve). Runs on a Linux VPS, controlled via Telegram.

## What this bot does

1. **Watches for new token launches** on Pump.fun (via signal server) and Meteora DBC (via WebSocket)
2. **Filters tokens** using configurable rules (market cap, holder count, fee activity, rug ratio, etc.)
3. **Analyzes tokens** using an AI model (MiniMax M2.7 by default)
4. **Executes trades** on Solana using Jupiter swap — currently in `dry_run` mode (simulated)
5. **Reports everything** to your Telegram chat

## Project structure

```
src/
├── signals/
│   ├── feeClaim.js       — detects Pump.fun fee events via WebSocket
│   ├── serverClient.js   — fetches pre-filtered signals from Charon signal server
│   ├── graduated.js      — polls Pump.fun for recently graduated tokens
│   ├── trending.js       — polls Jupiter/GMGN for trending tokens
│   └── meteoraDbc.js     — [CUSTOM] detects new Meteora DBC token launches
├── pipeline/
│   ├── orchestrator.js   — receives signals, runs enrichment + AI decision
│   ├── candidateBuilder.js — fetches token data from GMGN, Jupiter, Twitter
│   └── llm.js            — sends candidates to MiniMax AI for BUY/WATCH/PASS decision
├── execution/
│   ├── router.js         — routes trades to dry_run / confirm / live
│   └── positions.js      — monitors open positions, triggers exits
├── telegram/             — all Telegram bot commands and menus
├── db/                   — SQLite database layer
├── enrichment/           — GMGN, Jupiter, Twitter data fetchers
└── app.js                — startup orchestrator
```

## Custom additions (vs original repo)

| File | What was added |
|------|---------------|
| `src/signals/meteoraDbc.js` | New signal source: monitors Meteora DBC program for new pool creation events via Solana WebSocket |
| `src/config.js` | Added `METEORA_DBC_PROGRAM`, `ENABLE_METEORA_DBC`, `METEORA_DBC_POLL_MS` |
| `src/app.js` | Starts Meteora DBC WebSocket subscriber on bot launch |
| `.env` | Added `ENABLE_METEORA_DBC=true` and `METEORA_DBC_POLL_MS=10000` |

## Required .env values

Fill these in `.env` before starting the bot:

| Key | Where to get it |
|-----|----------------|
| `TELEGRAM_BOT_TOKEN` | @BotFather on Telegram |
| `TELEGRAM_CHAT_ID` | Send /start to your bot, read the ID |
| `HELIUS_API_KEY` | helius.dev |
| `SOLANA_PRIVATE_KEY` | Your Solana wallet (base58 format) |
| `SIGNAL_SERVER_KEY` | From Charon maintainer (yunus-0x) |
| `LLM_API_KEY` | MiniMax API key (or leave blank to disable AI) |

Set `GMGN_ENABLED=false` if you don't have a GMGN API key — the bot falls back to Jupiter data.

## Running the bot

### Start
```bash
npm start
```

### On VPS with PM2 (production)
```bash
pm2 start index.js --name charon
pm2 save
pm2 startup   # run the printed command to survive reboots
```

### PM2 commands
```bash
pm2 status              # is the bot running?
pm2 logs charon         # live log stream
pm2 logs charon --lines 100   # last 100 lines
pm2 restart charon      # restart after code changes
pm2 stop charon         # stop the bot
```

## Dual-environment workflow (Windows WSL + VPS)

Both environments clone from the same GitHub fork: `https://github.com/takahibe/charon`

```
Edit code on WSL or VPS with Claude Code
  → git push origin main
  → on the other side: git pull origin main
  → pm2 restart charon   (on VPS, to apply changes)
```

Note: `.env` is gitignored — fill it in separately on each machine.

## Telegram commands

| Command | What it does |
|---------|-------------|
| `/menu` | Open main control menu |
| `/positions` | View current dry-run positions |
| `/strategy` | Show active trading strategy |
| `/filters` | Show active token filters |
| `/candidate <mint>` | Inspect a specific token |
| `/learn` | Run learning/performance report |

## Trading modes

- `dry_run` — simulates trades in SQLite, no real money (current default)
- `confirm` — bot asks you via Telegram before each trade
- `live` — fully autonomous real trading (change only when ready)

To switch modes, edit `TRADING_MODE=` in `.env` and restart the bot.
