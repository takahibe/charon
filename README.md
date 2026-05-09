# Charon

Charon is a Telegram trench agent for screening noisy Pump-token flow with overlap signals, strategy gates, LLM selection, and dry-run/confirm/live execution.

The recommended setup runs two processes:

- `charon-server`: collects and merges public signals into a private API.
- `charon`: polls that API, enriches candidates, decides, executes, and manages positions.

## Flow

1. Signal server collects Jupiter trending, Axiom trending, GMGN trending, Pump graduated, and fee-claim WebSocket events.
2. Signal server merges by mint and serves overlap candidates from `GET /api/signals`.
3. Charon polls the signal server every `SIGNAL_POLL_MS`.
4. The active strategy gates source count, fee requirement, token age, market cap, holders, fees, trend quality, ATH distance, and position caps.
5. Passing candidates are enriched with GMGN token info, Jupiter asset/holders/chart data, saved-wallet exposure, and fxtwitter narrative.
6. The LLM screens up to `LLM_CANDIDATE_PICK_COUNT` recent candidates and may pick one `BUY`.
7. Charon routes approved buys through `dry_run`, `confirm`, or `live`.
8. Open positions are monitored every `POSITION_CHECK_MS` for TP, SL, trailing TP, max hold, and partial TP rules.

## Install

```bash
git clone git@github.com:yunus-0x/charon.git
cd charon
npm install
cp .env.example .env
```

Edit `.env`, then run:

```bash
npm start
```

For PM2:

```bash
pm2 start index.js --name charon
pm2 save
```

## Required Config

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
GMGN_API_KEY=
```

Use a signal server:

```env
SIGNAL_SERVER_URL=https://api.thecharon.xyz
SIGNAL_SERVER_KEY=
SIGNAL_POLL_MS=30000
```

RPC config is required for live execution and legacy standalone signal mode:

```env
SOLANA_RPC_URL=https://pump.helius-rpc.com/
SOLANA_WS_URL=wss://pump.helius-rpc.com/
```

If `SOLANA_RPC_URL` and `SOLANA_WS_URL` are not set, Charon falls back to Helius mainnet URLs and requires:

```env
HELIUS_API_KEY=
```

## LLM Config

```env
ENABLE_LLM=true
LLM_BASE_URL=https://api.minimax.io/v1
LLM_API_KEY=
LLM_MODEL=MiniMax-M2.7
LLM_TIMEOUT_MS=60000
LLM_CANDIDATE_PICK_COUNT=10
LLM_CANDIDATE_MAX_AGE_MS=600000
```

Each strategy has its own `llm_min_confidence`. Configure it from `/menu -> Strategy`, or:

```bash
/stratset sniper llm_min_confidence 70
```

## Execution Modes

```env
TRADING_MODE=dry_run
```

Modes:

- `dry_run`: stores simulated buys/sells in SQLite.
- `confirm`: creates a Telegram trade intent and waits for confirmation before live buy.
- `live`: signs and executes Jupiter swaps immediately after strategy and LLM approval.

Live mode also needs:

```env
SOLANA_PRIVATE_KEY=
JUPITER_API_KEY=
JUPITER_SWAP_BASE_URL=https://api.jup.ag/swap/v2
JUPITER_SLIPPAGE_BPS=300
LIVE_MIN_SOL_RESERVE=0.02
```

## Strategies

Use `/menu -> Strategy` or commands:

```bash
/strategy
/strategy sniper
/strategy dip_buy
/strategy smart_money
/strategy degen
/stratset sniper tp_percent 75
```

Default strategies:

- `sniper`: fee-claim overlap, immediate entry, LLM on.
- `dip_buy`: waits for ATH-distance dip alerts.
- `smart_money`: stricter holder/trending quality, partial TP support.
- `degen`: lower source threshold, rule-based by default.

Strategy settings are stored in SQLite and hot-read. Menu changes apply without restart.

## Telegram Commands

```bash
/menu
/strategy
/stratset <strategy_id> <key> <value>
/positions
/candidate <mint>
/filters
/pnl
/learn <window>
/lessons
/walletadd <label> <address>
/walletremove <label>
/wallets
```

## Storage

Charon uses `charon.sqlite` as source of truth. It stores:

- candidates and filter results
- LLM decisions and batches
- decision logs
- dry-run/live positions and trades
- trade intents
- saved wallets
- strategy configs
- price alerts
- learning runs and lessons

Open positions resume monitoring after restart.

## Signal Server Notes

The signal server is separate from this repo in the current VPS layout. It should:

- dedupe fee-claim events by `signature:mint`
- avoid hardcoded SOL/USD price
- serve `GET /api/signals` behind `x-api-key`
- collect signals continuously under PM2

Example Charon client config:

```env
SIGNAL_SERVER_URL=https://api.thecharon.xyz
SIGNAL_SERVER_KEY=your-server-key
```

## Verification

```bash
npm run check
```

## Config Reloading

SQLite/menu settings are hot-read by the bot. API keys, wallet key, RPC URLs, Jupiter base URL, and polling intervals are `.env` values and require restart.
