export function normalizeProfitLockConfig(strategy = {}) {
  const ladder = Array.isArray(strategy.profit_lock_ladder)
    ? strategy.profit_lock_ladder
    : Array.isArray(strategy.profitLockLadder)
      ? strategy.profitLockLadder
      : [];
  const roundtripCostBps = Number(
    strategy.execution_cost_bps_assumption
      ?? strategy.roundtrip_cost_bps
      ?? strategy.roundtripCostBps
      ?? 0,
  );
  const minNetProfitLockBps = Number(
    strategy.min_net_profit_lock_bps
      ?? strategy.minNetProfitLockBps
      ?? 0,
  );
  const enabled = Boolean(strategy.profit_lock_enabled ?? strategy.profitLockEnabled ?? ladder.length > 0);
  return {
    enabled,
    roundtripCostBps: Number.isFinite(roundtripCostBps) ? roundtripCostBps : 0,
    minNetProfitLockBps: Number.isFinite(minNetProfitLockBps) ? minNetProfitLockBps : 0,
    ladder: ladder
      .map((rung) => ({
        trigger_gross_bps: Number(rung.trigger_gross_bps ?? rung.triggerGrossBps),
        floor_gross_bps: Number(rung.floor_gross_bps ?? rung.floorGrossBps),
      }))
      .filter((rung) => Number.isFinite(rung.trigger_gross_bps) && Number.isFinite(rung.floor_gross_bps))
      .sort((a, b) => a.trigger_gross_bps - b.trigger_gross_bps),
  };
}

export function evaluateProfitLock({ highWaterGrossBps, currentGrossBps }, config = {}) {
  const normalized = Array.isArray(config.ladder)
    ? {
        enabled: config.enabled !== false,
        roundtripCostBps: Number(config.roundtripCostBps ?? config.roundtrip_cost_bps ?? 0),
        minNetProfitLockBps: Number(config.minNetProfitLockBps ?? config.min_net_profit_lock_bps ?? 0),
        ladder: config.ladder
          .map((rung) => ({
            trigger_gross_bps: Number(rung.trigger_gross_bps ?? rung.triggerGrossBps),
            floor_gross_bps: Number(rung.floor_gross_bps ?? rung.floorGrossBps),
          }))
          .filter((rung) => Number.isFinite(rung.trigger_gross_bps) && Number.isFinite(rung.floor_gross_bps))
          .sort((a, b) => a.trigger_gross_bps - b.trigger_gross_bps),
      }
    : normalizeProfitLockConfig(config);

  if (!normalized.enabled || !normalized.ladder.length) {
    return { armed: false, exit: false, reason: 'profit lock disabled' };
  }

  const highWater = Number(highWaterGrossBps);
  const current = Number(currentGrossBps);
  if (!Number.isFinite(highWater) || !Number.isFinite(current)) {
    return { armed: false, exit: false, reason: 'invalid pnl bps' };
  }

  const rung = normalized.ladder.reduce((selected, candidate) => (
    highWater >= candidate.trigger_gross_bps ? candidate : selected
  ), null);

  if (!rung) {
    return { armed: false, exit: false, reason: 'below first profit lock trigger' };
  }

  const floorNetBps = rung.floor_gross_bps - normalized.roundtripCostBps;
  const base = {
    armed: true,
    exit: false,
    triggerGrossBps: rung.trigger_gross_bps,
    floorGrossBps: rung.floor_gross_bps,
    floorNetBps,
    currentGrossBps: current,
    highWaterGrossBps: highWater,
  };

  if (floorNetBps < normalized.minNetProfitLockBps) {
    return { ...base, reason: `profit lock floor below min net (${floorNetBps} < ${normalized.minNetProfitLockBps} bps)` };
  }

  if (current <= rung.floor_gross_bps) {
    return { ...base, exit: true, exitReason: 'PROFIT_LOCK', reason: `retraced through profit lock floor ${rung.floor_gross_bps} bps` };
  }

  return { ...base, reason: 'above profit lock floor' };
}
