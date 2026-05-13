# Charon v1.1.1 — Risk-Control Patch

Status: dry-run first. This patch responds to the 06:01 cron audit showing negative dry-run PnL, poor stop-loss quality, noisy smartmoney, weak routes, and too many stale open positions.

## Changes

### 1. Degen strategy tightened

The existing `degen` strategy is force-migrated on DB init to:

```json
{
  "min_source_count": 2,
  "tp_percent": 100,
  "sl_percent": -20,
  "trailing_enabled": true,
  "trailing_percent": 15,
  "partial_tp": true,
  "partial_tp_at_percent": 100,
  "partial_tp_sell_percent": 50,
  "max_hold_ms": 7200000,
  "use_llm": true,
  "llm_min_confidence": 75
}
```

Intent: fewer weak entries, lock 50% at 2x, trail the rest, and stop holding trash longer than 2 hours.

### 2. Route pruning

Trench risk now supports:

- `trench_blocked_routes`
- `trench_preferred_routes`
- `min_source_count` enforcement

Default blocked routes:

```text
fee_trending, fee_graduated_trending
```

Reason: cron report showed fee-derived routes bleeding while dual-source/trending was least bad.

### 3. Emergency loss label

Position monitor now supports `trench_emergency_sl_percent`, default `-30`.

If a position refresh sees PnL below this level, it exits as:

```text
EMERGENCY_SL
```

This makes severe dumps visible separately from normal configured stop-losses.

### 4. Stale max-hold fallback

If a strategy has no explicit `max_hold_ms`, open positions use global fallback:

```text
stale_position_max_hold_ms = 6h
```

Degen has its own stricter 2h max hold. Sniper gets 6h.

### 5. Partial TP PnL fix

Dry-run final close now writes `finalPnlPercent/finalPnlSol`, including previously realized partial TP, instead of raw remaining-leg PnL.

## Safety stance

- Still dry-run.
- Smartmoney remains noisy and is not promoted to a buy command.
- Public wallet hits remain alerts only.
- This patch reduces exposure and weak routes; it does not increase size.

## What to watch next

After restart, next cron reports should show:

1. Open positions shrinking back to max policy.
2. Fewer fee-route entries.
3. Fewer weak LLM confidence buys.
4. Separate `EMERGENCY_SL` count if dumps are still slipping past normal SL.
5. Partial TP sell rows once runners hit +100%.
