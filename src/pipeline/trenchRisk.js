const KNOWN_TRENCH_WALLETS = {
  '3bMTqjwEemHWov6yKCJ7CrjVxe99S6UwJPev8obzjo8P': {
    label: 'badattrading_insider_3bMTq',
    source: 'badattrading_ public post 1974528723950108875',
    defaultWeight: 0,
  },
  '76ZUBj1JLz7arTVHSRJok5oSTEqDuVBgySFMVHtzxzZc': {
    label: 'badattrading_insider_76ZUBj',
    source: 'badattrading_ public post 1980391643535798485',
    defaultWeight: 0,
  },
};

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value, fallback = false) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

function utcHour(ts = Date.now()) {
  return new Date(ts).getUTCHours();
}

function tokenAgeMs(candidate) {
  const created = num(candidate?.createdAtMs, 0);
  const launch = num(candidate?.signals?.launchedAtMs || candidate?.signals?.createdAtMs || candidate?.trending?.created_at_ms || 0, 0);
  const start = launch || created;
  if (!start) return null;
  return Math.max(0, Date.now() - start);
}

function smartWalletHits(candidate) {
  const hits = [];
  const rows = candidate?.smartMoney?.rows || candidate?.smartMoney?.recentTrades || [];
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const maker = row?.maker || row?.wallet || row?.address;
      if (maker && KNOWN_TRENCH_WALLETS[maker]) hits.push({ address: maker, ...KNOWN_TRENCH_WALLETS[maker] });
    }
  }
  return hits;
}

export function knownTrenchWallets() {
  return { ...KNOWN_TRENCH_WALLETS };
}

export function assessTrenchRisk(candidate, strat = {}, settings = {}) {
  const enabled = bool(strat.trench_v11_enabled ?? settings.trench_v11_enabled, true);
  const failures = [];
  const warnings = [];
  const boosts = [];
  let score = 0;
  if (!enabled) return { enabled: false, score, failures, warnings, boosts };

  const mcap = num(candidate?.metrics?.marketCapUsd, NaN);
  const holderCount = num(candidate?.metrics?.holderCount, 0);
  const maxHolder = num(candidate?.holders?.maxHolderPercent, NaN);
  const bundlerRate = num(candidate?.trending?.bundler_rate, NaN);
  const rugRatio = num(candidate?.trending?.rug_ratio, NaN);
  const isWash = candidate?.trending?.is_wash_trading === true || candidate?.trending?.is_wash_trading === 1;
  const volumeUsd = num(candidate?.metrics?.trendingVolumeUsd ?? candidate?.trending?.volume, 0);
  const feesSol = num(candidate?.metrics?.gmgnTotalFeesSol, 0);
  const smartBuyers = num(candidate?.metrics?.smartMoneyUniqueBuyers5m, 0);
  const smartNetUsd = num(candidate?.metrics?.smartMoneyNetUsd5m, 0);
  const buyPressure = candidate?.metrics?.smartMoneyBuyPressure5m;

  const maxBundlerRate = num(strat.trench_max_bundler_rate ?? settings.trench_max_bundler_rate, 0.3);
  if (Number.isFinite(bundlerRate) && bundlerRate > maxBundlerRate) {
    failures.push(`trench bundle: bundler rate ${bundlerRate} > ${maxBundlerRate}`);
    score -= 10;
  }

  const maxRugRatio = num(strat.trench_max_rug_ratio ?? settings.trench_max_rug_ratio, 0.35);
  if (Number.isFinite(rugRatio) && rugRatio > maxRugRatio) {
    failures.push(`trench rug ratio: ${rugRatio} > ${maxRugRatio}`);
    score -= 6;
  }

  if (isWash) {
    failures.push('trench wash trading: external source flagged wash trading');
    score -= 8;
  }

  const maxSingleHolder = num(strat.trench_max_single_holder_percent ?? settings.trench_max_single_holder_percent, 25);
  if (Number.isFinite(maxHolder) && maxHolder > maxSingleHolder) {
    failures.push(`trench holder concentration: ${maxHolder}% > ${maxSingleHolder}%`);
    score -= 5;
  }

  const lowMcap = num(strat.trench_low_mcap_usd ?? settings.trench_low_mcap_usd, 50_000);
  if (Number.isFinite(mcap) && mcap > 0 && mcap < lowMcap) {
    warnings.push(`trench low-mcap tier: ${Math.round(mcap)} < ${lowMcap}; use micro-size only`);
    score -= 1;
  }

  const feeVolumeMin = num(strat.trench_min_fee_per_10k_volume_sol ?? settings.trench_min_fee_per_10k_volume_sol, 0);
  if (feeVolumeMin > 0 && volumeUsd > 0) {
    const feePer10kVolumeSol = feesSol / (volumeUsd / 10_000);
    if (feePer10kVolumeSol < feeVolumeMin) {
      warnings.push(`trench fee/volume weak: ${feePer10kVolumeSol.toFixed(4)} SOL per $10k volume < ${feeVolumeMin}`);
      score -= 2;
    } else {
      boosts.push(`trench fee/volume healthy: ${feePer10kVolumeSol.toFixed(4)} SOL per $10k volume`);
      score += 1;
    }
  }

  const minSmartBuyers = num(strat.trench_min_smart_buyers_5m ?? settings.trench_min_smart_buyers_5m, 0);
  if (minSmartBuyers > 0) {
    if (smartBuyers >= minSmartBuyers && smartNetUsd > 0 && (buyPressure == null || Number(buyPressure) >= 0.55)) {
      boosts.push(`trench smart-money pressure: ${smartBuyers} buyers, net $${Math.round(smartNetUsd)}`);
      score += 2;
    } else if (smartBuyers > 0) {
      warnings.push(`trench smart-money weak: ${smartBuyers} buyers, net $${Math.round(smartNetUsd)}`);
    }
  }

  const hourBoostEnabled = bool(strat.trench_eu_sleep_hour_boost ?? settings.trench_eu_sleep_hour_boost, true);
  const age = tokenAgeMs(candidate);
  const hour = utcHour(candidate?.createdAtMs || Date.now());
  if (hourBoostEnabled && hour >= 1 && hour <= 7 && (age == null || age < 6 * 60 * 60 * 1000)) {
    boosts.push(`trench timing boost: signal at ${hour}:00 UTC`);
    score += 1;
  }

  const walletHits = smartWalletHits(candidate);
  if (walletHits.length) {
    warnings.push(`trench known-wallet alert only: ${walletHits.map(h => h.label).join(', ')} (neutral until verified)`);
  }

  return { enabled: true, score, failures, warnings, boosts, walletHits };
}
