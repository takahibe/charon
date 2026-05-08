# Charon

Charon is a Telegram trench agent built for precision. It watches the noisy edge of new Pump launches, waits for stronger confirmation, enriches the setup, and lets an LLM pick from the best recent candidates instead of blindly chasing every alert.

It is designed to trade slowly enough to survive: filters first, batch screening, position caps, decision logs, TP/SL rules, and dry-run mode for tuning before real execution.

`dry_run` mode stores simulated positions. `confirm` mode stores a trade intent and waits for Telegram confirmation before signing the on-chain buy. `live` mode uses Jupiter Swap API v2 to buy and sell on-chain with the configured wallet.

## Flow

- Polls `https://advanced-api-v2.pump.fun/coins/graduated`.
- Polls Jupiter `GET /tokens/v2/toptrending/:window` for Pump-related trending mints by default. GMGN `GET /v1/market/rank` remains available as an optional trending source.
- Listens to Pump fee-claim logs through Helius WebSocket.
- Creates candidates from fee + graduated, fee + trending, or fee + graduated + trending.
- Optional degen mode can also create candidates from graduated + trending without a fee claim.
- Enriches with GMGN `GET /v1/token/info`, Jupiter asset search fallback market data, Jupiter holders, saved-wallet holdings/PnL, chart context, and fxtwitter narrative text when a social URL exists.
- Applies filters for fee SOL, mcap, fees, graduated volume, trending volume/swaps/risk, max top-holder percent, and saved-wallet holders.
- Sends a Telegram candidate alert with inline buttons.
- The LLM receives up to 10 recent eligible candidates and picks at most one buy candidate.
- If the selected candidate returns `BUY` above the confidence threshold, Charon routes it through `TRADING_MODE`.
- Auto-buys stop when open positions reach `max_open_positions`.
- Monitors open positions every `POSITION_CHECK_MS` and exits on TP, SL, or trailing TP.

## Setup

```bash
npm install
cp .env.example .env
npm start
```

Required env:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `HELIUS_API_KEY`
- `GMGN_API_KEY`

Optional env:

- `TELEGRAM_TOPIC_ID`
- `DB_PATH`
- `TRADING_MODE`
- `SOLANA_RPC_URL`
- `SOLANA_PRIVATE_KEY`
- `JUPITER_API_KEY`
- `JUPITER_SWAP_BASE_URL`
- `JUPITER_SLIPPAGE_BPS`
- `LIVE_MIN_SOL_RESERVE`
- `ENABLE_LLM`
- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- `LLM_TIMEOUT_MS`
- `LLM_CANDIDATE_PICK_COUNT`
- `LLM_CANDIDATE_MAX_AGE_MS`
- `MAX_OPEN_POSITIONS`
- `MIN_FEE_CLAIM_SOL`
- `GRADUATED_POLL_MS`
- `GRADUATED_LOOKBACK_MS`
- `TRENDING_POLL_MS`
- `TRENDING_LOOKBACK_MS`
- `TRENDING_ENABLED`
- `TRENDING_SOURCE`
- `TRENDING_ALLOW_DEGEN`
- `TRENDING_INTERVAL`
- `TRENDING_LIMIT`
- `TRENDING_ORDER_BY`
- `TRENDING_MIN_VOLUME_USD`
- `TRENDING_MIN_SWAPS`
- `TRENDING_MAX_RUG_RATIO`
- `TRENDING_MAX_BUNDLER_RATE`
- `GMGN_CACHE_TTL_MS`
- `POSITION_CHECK_MS`

## Telegram UX

Use `/menu` first. The inline menu includes:

- `Agent`
- `Filters`
- `Wallets`
- `Positions`
- `PnL`
- `Settings`

Candidate alert buttons:

- `View Candidate`
- `Dry Buy`
- `Ignore`
- `Set TP/SL`

Position buttons:

- `Dry Sell`
- `TP +25%`
- `TP +50%`
- `SL -15%`
- `SL -25%`
- `Trail On/Off`
- `Refresh`

Fallback commands:

- `/menu`
- `/positions`
- `/candidate <mint>`
- `/filters`
- `/pnl`
- `/learn <window>` e.g. `/learn 12h`
- `/lessons`
- `/walletadd <label> <address>`
- `/walletremove <label>`
- `/wallets`
- `/setfilter <name> <value>`

Useful `/setfilter` names:

- `trading_mode`
- `min_fee_claim_sol`
- `min_mcap_usd`
- `max_mcap_usd`
- `min_gmgn_total_fee_sol`
- `min_graduated_volume_usd`
- `max_top20_holder_percent`
- `min_saved_wallet_holders`
- `trending_enabled`
- `trending_source`
- `trending_allow_degen`
- `trending_interval`
- `trending_limit`
- `trending_order_by`
- `trending_min_volume_usd`
- `trending_min_swaps`
- `trending_max_rug_ratio`
- `trending_max_bundler_rate`
- `llm_min_confidence`
- `llm_candidate_pick_count`
- `llm_candidate_max_age_ms`
- `max_open_positions`
- `dry_run_buy_sol`
- `default_tp_percent`
- `default_sl_percent`
- `default_trailing_enabled`
- `default_trailing_percent`

## Storage

SQLite is the source of truth. Charon creates these tables on boot:

- `candidates`
- `alerts`
- `llm_decisions`
- `llm_batches`
- `decision_logs`
- `trade_intents`
- `dry_run_positions`
- `dry_run_trades`
- `tp_sl_rules`
- `saved_wallets`
- `settings`
- `signal_events`
- `learning_runs`
- `learning_lessons`

Open positions resume monitoring after restart.

Live mode requires `TRADING_MODE=live`, `SOLANA_PRIVATE_KEY`, and `JUPITER_API_KEY`. Keep `dry_run` for simulation.

`decision_logs` stores the entry decision journal: selected token data, full candidate snapshot, batch context, guardrail state, action taken, and execution result/error. Use it later to tune prompts, filters, and risk rules.

`/learn <window>` runs a manual learning pass over dry-run evidence. It summarizes closed dry-run PnL, route performance, LLM batch decisions, and guardrail actions, then stores active lessons in `learning_lessons`. Future LLM screening prompts include the latest active lessons.

## Configuration Reloading

Telegram/menu settings are stored in SQLite and are hot-read by the bot. Changes to filters, GMGN trending settings, TP/SL defaults, trading mode, batch size, max positions, and dry-run/live buy size apply without restart.

`.env` values are read at process start. API keys, wallet private key, RPC URL, Jupiter base URL, slippage env default, and polling intervals require a restart.
