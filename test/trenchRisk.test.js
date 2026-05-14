import test from 'node:test';
import assert from 'node:assert/strict';
import { assessTrenchRisk } from '../src/pipeline/trenchRisk.js';

function candidate(overrides = {}) {
  return {
    createdAtMs: Date.UTC(2026, 4, 13, 2, 0, 0),
    metrics: {
      marketCapUsd: 40_000,
      holderCount: 75,
      gmgnTotalFeesSol: 1,
      trendingVolumeUsd: 50_000,
      smartMoneyUniqueBuyers5m: 3,
      smartMoneyNetUsd5m: 2000,
      smartMoneyBuyPressure5m: 0.7,
      ...(overrides.metrics || {}),
    },
    holders: { maxHolderPercent: 12, ...(overrides.holders || {}) },
    trending: { bundler_rate: 0.1, rug_ratio: 0.1, is_wash_trading: false, ...(overrides.trending || {}) },
    smartMoney: { rows: [], ...(overrides.smartMoney || {}) },
    signals: {
      route: 'graduated_trending',
      hasGraduated: true,
      hasTrending: true,
      ...(overrides.signals || {}),
    },
  };
}

test('trench risk rejects high bundler, rug, wash, and holder concentration', () => {
  const result = assessTrenchRisk(candidate({
    holders: { maxHolderPercent: 40 },
    trending: { bundler_rate: 0.8, rug_ratio: 0.7, is_wash_trading: true },
  }), { trench_v11_enabled: true });
  assert.equal(result.failures.length, 4);
  assert.match(result.failures.join('\n'), /bundler rate/);
  assert.match(result.failures.join('\n'), /rug ratio/);
  assert.match(result.failures.join('\n'), /wash trading/);
  assert.match(result.failures.join('\n'), /holder concentration/);
});

test('trench risk keeps known wallet as neutral alert until verified', () => {
  const result = assessTrenchRisk(candidate({
    smartMoney: { rows: [{ maker: '3bMTqjwEemHWov6yKCJ7CrjVxe99S6UwJPev8obzjo8P', side: 'buy' }] },
  }), { trench_v11_enabled: true });
  assert.equal(result.failures.length, 0);
  assert.equal(result.walletHits.length, 1);
  assert.match(result.warnings.join('\n'), /known-wallet alert only/);
});

test('trench risk can boost smart-money pressure without bypassing hard failures', () => {
  const result = assessTrenchRisk(candidate(), {
    trench_v11_enabled: true,
    trench_min_smart_buyers_5m: 2,
    trench_min_fee_per_10k_volume_sol: 0.1,
  });
  assert.equal(result.failures.length, 0);
  assert.ok(result.score > 0);
  assert.match(result.boosts.join('\n'), /smart-money pressure/);
});

test('trench risk blocks bad routes and enforces multi-source entries', () => {
  const result = assessTrenchRisk(candidate({
    signals: { route: 'fee_trending', hasFeeClaim: true, hasGraduated: false, hasTrending: true },
  }), {
    trench_v11_enabled: true,
    trench_blocked_routes: ['fee_trending'],
    min_source_count: 3,
  });
  assert.match(result.failures.join('\n'), /route blocked/);
  assert.match(result.failures.join('\n'), /source count/);
});

test('trench risk honors explicit server sourceCount for dual_source route', () => {
  const result = assessTrenchRisk(candidate({
    signals: {
      route: 'dual_source',
      hasFeeClaim: false,
      hasGraduated: false,
      hasTrending: false,
      sourceCount: 2,
    },
  }), {
    trench_v11_enabled: true,
    min_source_count: 2,
  });
  assert.doesNotMatch(result.failures.join('\n'), /source count/);
});

test('trench risk blocks graduated_trending when lessons mark it deprecated', () => {
  const result = assessTrenchRisk(candidate(), {
    trench_v11_enabled: true,
    trench_blocked_routes: ['graduated_trending'],
  });
  assert.match(result.failures.join('\n'), /trench route blocked: graduated_trending/);
});
