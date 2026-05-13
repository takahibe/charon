# Charon v1.1 — Trench Intel Patch

Status: dry-run first. Do not switch to confirm/live from this patch alone.

This patch converts the first trench-intel batch (Ponyin, BadAtTrading/Nova, ELPonyin) into deterministic Charon guardrails and dry-run signals.

## Added

### 1. Trench risk assessment

`src/pipeline/trenchRisk.js` adds a deterministic `assessTrenchRisk(candidate, strat)` function.

It currently handles:

- hard reject on high bundler rate
- hard reject on high rug ratio
- hard reject on wash-trading flag
- hard reject on single-holder concentration above threshold
- low-market-cap warning tier below 50k
- optional fee/volume sanity signal
- optional smart-money pressure boost
- weak UTC 01:00–07:00 timing boost for sub-6h tokens
- known-wallet alerts for public wallets from BadAtTrading/Nova, but **neutral weight until verified**

The trench assessment is attached to `candidate.filters.trench` and hard failures are appended to normal filter failures.

### 2. Known-wallet alerts, not blind copytrading

The two public wallets from BadAtTrading are recognized as alerts only:

- `3bMTqjwEemHWov6yKCJ7CrjVxe99S6UwJPev8obzjo8P`
- `76ZUBj1JLz7arTVHSRJok5oSTEqDuVBgySFMVHtzxzZc`

They do **not** auto-boost entry score yet. They need dry-run PnL verification first.

### 3. Partial take-profit accounting

Dry-run partial TP now records a `PARTIAL_TP` sell trade, reduces remaining open `size_sol`, and stores `partial_realized_sol` so final PnL includes profit already locked.

This directly targets the current Charon wound: giving back green positions.

### 4. Slippage cap for Jupiter live routes

Jupiter order requests now include `slippageBps` and cap it using settings:

- `jupiter_slippage_bps` default: `200`
- `jupiter_max_slippage_bps` default: `200`

Even if env/config is looser, live order slippage is capped by `jupiter_max_slippage_bps`.

### 5. Strategy defaults migrated

Existing strategies receive trench v1.1 default keys if missing:

```json
{
  "trench_v11_enabled": true,
  "trench_max_bundler_rate": 0.3,
  "trench_max_rug_ratio": 0.35,
  "trench_max_single_holder_percent": 25,
  "trench_low_mcap_usd": 50000,
  "trench_min_fee_per_10k_volume_sol": 0,
  "trench_min_smart_buyers_5m": 0,
  "trench_eu_sleep_hour_boost": true
}
```

## Dry-run experiments to watch

1. Do trench failures reduce new garbage entries?
2. Do partial TP rows appear before final exits?
3. Does final PnL include `partial_realized_sol`?
4. Are known-wallet alerts correlated with winners, or just public-alpha bait?
5. Does the 01:00–07:00 UTC boost matter, or is it stale alpha?

## Safety stance

- Keep `trading_mode=dry_run`.
- Known wallets are alerts only.
- Burns/caller posts remain manual-only.
- Bundle/rug/wash/concentration controls are hard risk gates.
- No X API dependency added.
