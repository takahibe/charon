# Charon v1.1.2 — Floating PnL Visibility Patch

Status: dry-run safe. No entry/exit logic is loosened.

## Purpose

Before this patch, open rows usually had `pnl_percent`/`pnl_sol = null` until close. Telegram could infer a value from high-water mcap, but SQLite/cron reports could not reliably see current open-position quality.

This patch persists current floating state on every position refresh.

## Added SQLite columns

`dry_run_positions` now has:

- `current_price REAL`
- `current_mcap REAL`
- `floating_pnl_percent REAL`
- `floating_pnl_sol REAL`
- `last_refreshed_at_ms INTEGER`

Columns are added via `ensureColumn()` during DB init.

## Runtime behavior

Every `refreshPosition()` call now writes:

```text
current_price
current_mcap
floating_pnl_percent
floating_pnl_sol
last_refreshed_at_ms
```

Position monitor interval remains unchanged:

```text
POSITION_CHECK_MS = 10_000 ms
```

So open-position floating PnL should update roughly every 10 seconds when the Jupiter asset API responds.

## Telegram/report behavior

Open-position PnL now prefers `floating_pnl_*` values before falling back to realized `pnl_*` or high-water inference.

Open position lines now include:

```text
Entry · Current · High
```

Full position render also includes `last_refreshed_at_ms` as ISO time.

## Safety

- No change to trade mode.
- No change to position size.
- No change to buy filters.
- No change to exit thresholds.

This is observability only.
