import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateProfitLock } from '../src/execution/profitLock.js';

const ladder = [
  { trigger_gross_bps: 2000, floor_gross_bps: 500 },
  { trigger_gross_bps: 3000, floor_gross_bps: 1500 },
  { trigger_gross_bps: 5000, floor_gross_bps: 2500 },
  { trigger_gross_bps: 7500, floor_gross_bps: 4000 },
  { trigger_gross_bps: 10000, floor_gross_bps: 6000 },
];

function config(overrides = {}) {
  return {
    enabled: true,
    roundtripCostBps: 450,
    minNetProfitLockBps: 1000,
    ladder,
    ...overrides,
  };
}

test('profit lock stays inactive until high-water reaches a ladder trigger', () => {
  const result = evaluateProfitLock({ highWaterGrossBps: 1999, currentGrossBps: 400 }, config());
  assert.equal(result.armed, false);
  assert.equal(result.exit, false);
});

test('profit lock requires locked floor to clear net execution cost threshold', () => {
  const result = evaluateProfitLock({ highWaterGrossBps: 2500, currentGrossBps: 400 }, config());
  assert.equal(result.armed, true);
  assert.equal(result.floorGrossBps, 500);
  assert.equal(result.floorNetBps, 50);
  assert.equal(result.exit, false);
  assert.match(result.reason, /below min net/);
});

test('profit lock exits when current pnl retraces through a net-qualified floor', () => {
  const result = evaluateProfitLock({ highWaterGrossBps: 3200, currentGrossBps: 1490 }, config());
  assert.equal(result.armed, true);
  assert.equal(result.floorGrossBps, 1500);
  assert.equal(result.floorNetBps, 1050);
  assert.equal(result.exit, true);
  assert.equal(result.exitReason, 'PROFIT_LOCK');
});

test('profit lock follows highest reached ladder rung', () => {
  const result = evaluateProfitLock({ highWaterGrossBps: 7600, currentGrossBps: 2600 }, config());
  assert.equal(result.armed, true);
  assert.equal(result.triggerGrossBps, 7500);
  assert.equal(result.floorGrossBps, 4000);
  assert.equal(result.exit, true);
});

test('profit lock is disabled explicitly', () => {
  const result = evaluateProfitLock({ highWaterGrossBps: 10000, currentGrossBps: -5000 }, config({ enabled: false }));
  assert.equal(result.armed, false);
  assert.equal(result.exit, false);
});
