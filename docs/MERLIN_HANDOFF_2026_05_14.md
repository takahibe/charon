# Merlin Handoff — Charon Session 2026-05-14

Audience: Merlin / next agent / future Asta session.

## Repo State

- Repo: https://github.com/takahibe/charon
- Path on VPS: `/root/charon`
- Branch: `main`
- Latest commit at handoff: `1d03c73c3d80ab8e23ebe689ec6a0d778771ae11`
- Commit message: `feat: persist floating position PnL`
- Push: confirmed to `origin/main`
- PM2 app: `charon`
- Runtime version: `1.1.2`
- Trading mode: `dry_run`

## What Was Done This Session

### v1.1 trench guardrails

Implemented dry-run-safe trench filters:

- bundler-rate hard reject
- rug-ratio hard reject
- wash-trading hard reject
- single-holder concentration hard reject
- low-mcap warning tier
- public known-wallet sightings as neutral alerts, not buy triggers
- smart-money pressure as boost only, not hard override
- Jupiter slippage cap via settings
- partial take-profit accounting foundation

Docs:

- `docs/CHARON_V1_1_TRENCH_PATCH.md`

### v1.1.1 risk-control patch

Implemented after cron audit showed bleeding/noisy entries:

- active `degen` tightened to `min_source_count: 2`
- `llm_min_confidence: 75`
- partial TP enabled: sell 50% at +100%
- trailing enabled with 15% trail
- `max_hold_ms: 7200000` for degen positions
- global stale fallback `stale_position_max_hold_ms: 21600000`
- `trench_emergency_sl_percent: -30`
- blocked weak routes: `fee_trending`, `fee_graduated_trending`
- preferred routes: `dual_source`, `trending`, `graduated_trending`
- fixed final dry-run close to use full realized partial-PnL-aware values

Docs:

- `docs/CHARON_V1_1_1_RISK_CONTROL_PATCH.md`

### v1.1.2 floating PnL visibility patch

Asta asked for open-position live/floating metrics to persist every refresh.

Added columns to `dry_run_positions`:

- `current_price REAL`
- `current_mcap REAL`
- `floating_pnl_percent REAL`
- `floating_pnl_sol REAL`
- `last_refreshed_at_ms INTEGER`

Updated `refreshPosition()` so every position refresh writes those fields.

Updated Telegram formatting so open positions prefer `floating_pnl_*` before fallback inference, and render:

- Entry mcap
- Current mcap
- High mcap
- Refresh time in detailed position view

Docs:

- `docs/CHARON_V1_1_2_FLOATING_PNL_PATCH.md`

## Current Runtime Mechanism

Intervals verified during session:

- signal server poll: every 5 seconds
- position monitor: every 10 seconds
- smart-money poll: every 60 seconds
- trending poll config: every 60 seconds

Current strategy shape:

```json
{
  "id": "degen",
  "min_source_count": 2,
  "max_open_positions": 5,
  "partial_tp": true,
  "partial_tp_at_percent": 100,
  "partial_tp_sell_percent": 50,
  "max_hold_ms": 7200000,
  "use_llm": true,
  "llm_min_confidence": 75,
  "blocked_routes": ["fee_trending", "fee_graduated_trending"]
}
```

Entry path now requires:

1. hard filters pass
2. source count >= 2
3. route not blocked
4. LLM BUY/WATCH logic passes with confidence >= 75 for BUY execution
5. position cap permits entry

Exit path checks every ~10 seconds:

- partial TP at +100%
- TP / trailing TP
- SL
- emergency SL
- max hold

## Verification Completed

After v1.1.2:

```text
npm run check: pass
npm test: pass
PM2 charon: online
version: 1.1.2
mode: dry_run
new DB columns: present
```

Latest closed positions observed after v1.1.1:

- KEVUN: `TRAILING_TP`, about `+93.04%`, `+0.0513 SOL`
- GKC: `MAX_HOLD`, about `+3.28%`, `+0.00164 SOL`

At v1.1.2 verification time, open positions were `0`, so the new floating columns are present but will populate on next open position refresh.

## Cron Job Context

Cron job exists:

- job name: `Charon dry-run analyst report`
- job_id: `fe6f8e543c9e`
- delivery: Telegram origin
- schedule: every 360m
- model changed to MiniMax-M2.7 for cost control

Important scanner pitfall:

- Do not attach skills or set `workdir=/root/charon` on this cron job unless needed.
- Hermes may auto-inject skill text or `CLAUDE.md`, causing prompt threat false positives.
- Current safer shape: terminal-only, no skills, no workdir, absolute paths under `/root/charon`.

## Next Recommended Checks

1. Wait for next dry-run open position.
2. Confirm these fields become non-null within ~10–20 seconds:
   - `current_mcap`
   - `floating_pnl_percent`
   - `floating_pnl_sol`
   - `last_refreshed_at_ms`
3. Compare next cron report:
   - open position count <= 5
   - fee routes no longer entering
   - SL quality improves
   - partial TP appears on runners
   - emergency SL frequency is visible
4. Do not recommend confirm/live until dry-run has multiple cycles of positive realized PnL and sane exit quality.

## Safety / Operator Notes

- Keep Charon in `dry_run` unless Asta explicitly approves confirm/live.
- Do not paste `.env` or wallet/private key values into Telegram.
- For diagnostics, print only key presence/length/masked prefix if absolutely needed.
- Charon loads wallet info and logs wallet public key; that is okay, but never expose private key material.

## Handoff Rule Compliance

This handoff was written after pushing the code commit:

- repo URL: https://github.com/takahibe/charon
- branch: `main`
- latest code commit: `1d03c73c3d80ab8e23ebe689ec6a0d778771ae11`
- push: confirmed
