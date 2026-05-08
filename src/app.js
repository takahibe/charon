import axios from 'axios';
import Database from 'better-sqlite3';
import TelegramBot from 'node-telegram-bot-api';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { setDefaultResultOrder } from 'node:dns';
import {
  APP_NAME,
  DB_PATH,
  PUMP_PROGRAM,
  PUMP_AMM,
  DISC_DIST_FEES,
  WSOL_MINT,
  SOL_MINT,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TELEGRAM_TOPIC_ID,
  SOLANA_WS_URL,
  GMGN_API_KEY,
  JUPITER_API_KEY,
  LIVE_MIN_SOL_RESERVE_LAMPORTS,
  LLM_BASE_URL,
  LLM_API_KEY,
  LLM_MODEL,
  GRADUATED_POLL_MS,
  GRADUATED_LOOKBACK_MS,
  TRENDING_POLL_MS,
  TRENDING_LOOKBACK_MS,
  GMGN_CACHE_TTL_MS,
  POSITION_CHECK_MS,
  LLM_TIMEOUT_MS,
  ENABLE_LLM,
  JSON_HEADERS,
  validateConfig,
} from './config.js';
import { accountLink, escapeHtml, fmtPct, fmtSol, fmtUsd, gmgnLink, short, txLink } from './format.js';
import { executeJupiterSwap, initLiveExecution, liveWalletBalanceLamports } from './liveExecutor.js';

setDefaultResultOrder('ipv4first');
validateConfig();

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const db = new Database(DB_PATH);
const graduated = new Map();
const trending = new Map();
const gmgnCache = new Map();
const seenFeeClaims = new Map();
const seenSignalCandidates = new Map();
const pendingNumericInputs = new Map();
const jupiterAssetCache = new Map();
let jupiterAssetBackoffUntil = 0;
let lastGmgnRequestAt = 0;
let gmgnQueue = Promise.resolve();
const gmgnBackoff = {
  tokenUntil: 0,
  tokenReason: '',
  trendingUntil: 0,
  trendingReason: '',
};

function now() {
  return Date.now();
}

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function paceGmgnRequest() {
  const delayMs = Math.max(0, numSetting('gmgn_request_delay_ms', 2500));
  if (!delayMs) return;
  const elapsed = now() - lastGmgnRequestAt;
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  lastGmgnRequestAt = now();
}

function enqueueGmgn(work) {
  const run = gmgnQueue.then(work, work);
  gmgnQueue = run.catch(() => {});
  return run;
}

function gmgnErrorText(status, payload, fallback) {
  const raw = String(payload?.raw || payload?.message || payload?.error || fallback || '');
  if (/<title>\s*Just a moment/i.test(raw) || /challenge-platform|cf_chl/i.test(raw)) {
    return 'Cloudflare managed challenge';
  }
  return `${status || ''} ${payload?.code || ''} ${raw}`.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value.filter(item => item != null && item !== '')) {
        url.searchParams.append(key, String(entry));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

async function gmgnFetch(pathname, { params = {} } = {}) {
  return enqueueGmgn(async () => {
    const url = new URL(`https://openapi.gmgn.ai${pathname}`);
    appendParams(url, {
      ...params,
      timestamp: Math.floor(now() / 1000),
      client_id: randomUUID(),
    });
    const maxRetries = Math.max(0, Math.floor(numSetting('gmgn_max_retries', 2)));
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await paceGmgnRequest();
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'X-APIKEY': GMGN_API_KEY,
          'Content-Type': 'application/json',
        },
      });
      const text = await res.text().catch(() => '');
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }
      if (res.ok) return payload;
      const message = gmgnErrorText(res.status, payload, `GMGN ${pathname} ${res.status}`);
      const rateLimited = res.status === 429 || /rate limit|temporarily banned/i.test(String(message));
      if (rateLimited && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const backoffMs = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : /temporarily banned/i.test(String(message))
            ? 60_000
            : Math.min(30_000, 3000 * 2 ** attempt);
        await sleep(backoffMs);
        continue;
      }
      const error = new Error(message);
      error.response = { status: res.status, data: payload, headers: Object.fromEntries(res.headers.entries()) };
      throw error;
    }
    throw new Error(`GMGN ${pathname} failed`);
  });
}

function gmgnBackoffKey(kind) {
  return kind === 'trending' ? 'trendingUntil' : 'tokenUntil';
}

function gmgnReasonKey(kind) {
  return kind === 'trending' ? 'trendingReason' : 'tokenReason';
}

function gmgnBackoffActive(kind) {
  return now() < Number(gmgnBackoff[gmgnBackoffKey(kind)] || 0);
}

function setGmgnBackoff(kind, err) {
  const status = err.response?.status;
  if (status !== 403 && status !== 429) return;
  const body = err.response?.data || {};
  const resetAtMs = Number(body.reset_at || 0) * 1000;
  const challenge = /Cloudflare managed challenge/i.test(String(err.message));
  const fallbackMs = challenge ? 30 * 60 * 1000 : status === 403 ? 10 * 60 * 1000 : 60 * 1000;
  const until = resetAtMs > now() ? resetAtMs : now() + fallbackMs;
  const reason = gmgnErrorText(status, body, err.message);
  gmgnBackoff[gmgnBackoffKey(kind)] = until;
  gmgnBackoff[gmgnReasonKey(kind)] = reason;
  console.log(`[gmgn:${kind}] backing off until ${new Date(until).toISOString()} (${reason})`);
}

function gmgnStatusText(kind) {
  const key = gmgnBackoffKey(kind);
  if (!gmgnBackoffActive(kind)) return 'ok';
  const seconds = Math.max(1, Math.ceil((Number(gmgnBackoff[key]) - now()) / 1000));
  return `blocked ${seconds}s`;
}

function jupiterAssetBackoffActive() {
  return now() < jupiterAssetBackoffUntil;
}

function setJupiterAssetBackoff(err) {
  if (err.response?.status !== 429) return;
  const resetHeader = Number(err.response?.headers?.['x-ratelimit-reset'] || 0);
  const resetMs = resetHeader > 1_000_000_000_000 ? resetHeader : resetHeader * 1000;
  jupiterAssetBackoffUntil = resetMs > now() ? resetMs : now() + 30_000;
  console.log(`[asset] backing off until ${new Date(jupiterAssetBackoffUntil).toISOString()} (429)`);
}

function initDb() {
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saved_wallets (
      label TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      signature TEXT,
      signal_key TEXT,
      candidate_json TEXT NOT NULL,
      filter_result_json TEXT NOT NULL,
      UNIQUE(signature, mint)
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at_ms INTEGER NOT NULL,
      telegram_message_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      verdict TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      risks_json TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      candidate_ids_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER,
      mint TEXT NOT NULL,
      symbol TEXT,
      status TEXT NOT NULL,
      opened_at_ms INTEGER NOT NULL,
      closed_at_ms INTEGER,
      size_sol REAL NOT NULL,
      entry_price REAL,
      entry_mcap REAL,
      token_amount_est REAL,
      high_water_price REAL,
      high_water_mcap REAL,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      trailing_armed INTEGER NOT NULL DEFAULT 0,
      exit_price REAL,
      exit_mcap REAL,
      exit_reason TEXT,
      pnl_percent REAL,
      pnl_sol REAL,
      llm_decision_id INTEGER,
      execution_mode TEXT DEFAULT 'dry_run',
      entry_signature TEXT,
      exit_signature TEXT,
      token_amount_raw TEXT,
      snapshot_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dry_run_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      side TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      price REAL,
      mcap REAL,
      size_sol REAL,
      token_amount_est REAL,
      reason TEXT,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tp_sl_rules (
      position_id INTEGER PRIMARY KEY,
      tp_percent REAL NOT NULL,
      sl_percent REAL NOT NULL,
      trailing_enabled INTEGER NOT NULL,
      trailing_percent REAL NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trade_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      mint TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      side TEXT NOT NULL,
      size_sol REAL NOT NULL,
      confidence REAL,
      reason TEXT,
      llm_decision_id INTEGER,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS decision_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_ms INTEGER NOT NULL,
      batch_id INTEGER,
      trigger_candidate_id INTEGER,
      selected_candidate_id INTEGER,
      selected_mint TEXT,
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      verdict TEXT,
      confidence REAL,
      reason TEXT,
      guardrails_json TEXT NOT NULL,
      token_json TEXT NOT NULL,
      candidate_json TEXT NOT NULL,
      batch_json TEXT NOT NULL,
      execution_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mint TEXT NOT NULL,
      kind TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      source TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      window_ms INTEGER NOT NULL,
      summary_json TEXT NOT NULL,
      lessons_json TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      lesson TEXT NOT NULL,
      evidence_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_candidates_mint ON candidates(mint);
    CREATE INDEX IF NOT EXISTS idx_positions_status ON dry_run_positions(status);
    CREATE INDEX IF NOT EXISTS idx_trade_intents_status ON trade_intents(status);
    CREATE INDEX IF NOT EXISTS idx_decision_logs_mint ON decision_logs(selected_mint);
    CREATE INDEX IF NOT EXISTS idx_signal_events_mint ON signal_events(mint);
    CREATE INDEX IF NOT EXISTS idx_learning_lessons_status ON learning_lessons(status, created_at_ms);
  `);
  ensureColumn('candidates', 'signal_key', 'TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_signal_key ON candidates(signal_key) WHERE signal_key IS NOT NULL');
  ensureColumn('dry_run_positions', 'execution_mode', "TEXT DEFAULT 'dry_run'");
  ensureColumn('dry_run_positions', 'entry_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'exit_signature', 'TEXT');
  ensureColumn('dry_run_positions', 'token_amount_raw', 'TEXT');

  const defaults = {
    agent_enabled: 'true',
    trading_mode: process.env.TRADING_MODE || 'dry_run',
    llm_candidate_pick_count: process.env.LLM_CANDIDATE_PICK_COUNT || '10',
    llm_candidate_max_age_ms: process.env.LLM_CANDIDATE_MAX_AGE_MS || String(10 * 60 * 1000),
    llm_min_confidence: '75',
    max_open_positions: process.env.MAX_OPEN_POSITIONS || '3',
    dry_run_buy_sol: '0.1',
    default_tp_percent: '50',
    default_sl_percent: '-25',
    default_trailing_enabled: 'true',
    default_trailing_percent: '20',
    min_fee_claim_sol: process.env.MIN_FEE_CLAIM_SOL || '2',
    min_mcap_usd: '0',
    max_mcap_usd: '0',
    min_gmgn_total_fee_sol: '0',
    min_graduated_volume_usd: '0',
    max_top20_holder_percent: '100',
    min_saved_wallet_holders: '0',
    gmgn_request_delay_ms: process.env.GMGN_REQUEST_DELAY_MS || '2500',
    gmgn_max_retries: process.env.GMGN_MAX_RETRIES || '2',
    trending_enabled: process.env.TRENDING_ENABLED || 'true',
    trending_source: process.env.TRENDING_SOURCE || 'jupiter',
    trending_allow_degen: process.env.TRENDING_ALLOW_DEGEN || 'false',
    trending_interval: process.env.TRENDING_INTERVAL || '5m',
    trending_limit: process.env.TRENDING_LIMIT || '100',
    trending_order_by: process.env.TRENDING_ORDER_BY || 'volume',
    trending_min_volume_usd: process.env.TRENDING_MIN_VOLUME_USD || '0',
    trending_min_swaps: process.env.TRENDING_MIN_SWAPS || '0',
    trending_max_rug_ratio: process.env.TRENDING_MAX_RUG_RATIO || '0.3',
    trending_max_bundler_rate: process.env.TRENDING_MAX_BUNDLER_RATE || '0.5',
  };
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(defaults)) insert.run(key, value);
}

function ensureColumn(table, column, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function setting(key, fallback = '') {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function boolSetting(key, fallback = false) {
  const value = setting(key, fallback ? 'true' : 'false');
  return value === 'true' || value === '1' || value === 'yes';
}

function numSetting(key, fallback = 0) {
  const value = Number(setting(key, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

function base58Encode(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  for (const b of bytes) {
    if (b !== 0) break;
    digits.push(0);
  }
  return digits.reverse().map(x => alphabet[x]).join('');
}

function readPubkey(buf, offset) {
  return base58Encode(buf.subarray(offset, offset + 32));
}

function readU64(buf, offset) {
  return buf.readBigUInt64LE(offset);
}

function readI64(buf, offset) {
  return buf.readBigInt64LE(offset);
}

function lamToSol(lamports) {
  return Number(lamports) / 1_000_000_000;
}

function discMatch(buf, disc) {
  return disc.every((b, i) => buf[i] === b);
}

function parseDistFees(data) {
  let offset = 8;
  const timestamp = readI64(data, offset); offset += 8;
  const mint = readPubkey(data, offset); offset += 32;
  const bondingCurve = readPubkey(data, offset); offset += 32;
  const sharingConfig = readPubkey(data, offset); offset += 32;
  const admin = readPubkey(data, offset); offset += 32;
  const count = data.readUInt32LE(offset); offset += 4;
  const shareholders = [];
  for (let i = 0; i < count && offset + 34 <= data.length; i++) {
    const pubkey = readPubkey(data, offset); offset += 32;
    const bps = data.readUInt16LE(offset); offset += 2;
    shareholders.push({ pubkey, bps });
  }
  const distributed = data.length >= offset + 8 ? readU64(data, offset) : 0n;
  return { timestamp, mint, bondingCurve, sharingConfig, admin, shareholders, distributed };
}

function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
}

function pruneSeen(map, ttlMs) {
  const at = now();
  for (const [key, ts] of map) {
    if (at - ts > ttlMs) map.delete(key);
  }
}

function marketCapFromGmgn(info) {
  const direct = Number(info?.market_cap ?? info?.mcap);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const price = Number(info?.price);
  const supply = Number(info?.circulating_supply ?? info?.total_supply);
  return Number.isFinite(price) && Number.isFinite(supply) ? price * supply : null;
}

function tokenPriceFromGmgn(info) {
  const price = Number(info?.price);
  return Number.isFinite(price) ? price : null;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

async function fetchGraduatedCoins() {
  const res = await axios.get('https://advanced-api-v2.pump.fun/coins/graduated', {
    timeout: 10_000,
    headers: JSON_HEADERS,
  });
  const coins = Array.isArray(res.data?.coins) ? res.data.coins : [];
  const cutoff = now() - GRADUATED_LOOKBACK_MS;
  for (const coin of coins) {
    const mint = coin?.coinMint;
    if (!mint) continue;
    const graduationDate = Number(coin.graduationDate || 0);
    if (graduationDate > 0 && graduationDate < cutoff) continue;
    graduated.set(mint, { ...coin, seenAt: now() });
  }
  for (const [mint, coin] of graduated) {
    const ts = Number(coin.graduationDate || coin.seenAt || 0);
    if (ts > 0 && ts < cutoff) graduated.delete(mint);
  }
  console.log(`[graduated] loaded ${coins.length}, tracking ${graduated.size}`);
}

function storeSignalEvent(mint, kind, source, payload) {
  db.prepare(`
    INSERT INTO signal_events (mint, kind, at_ms, source, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(mint, kind, now(), source, json(payload));
}

function normalizedTrendingRows(payload) {
  const rows = payload?.data?.data?.rank
    || payload?.data?.rank
    || payload?.rank
    || payload?.data?.data
    || payload?.data
    || [];
  return Array.isArray(rows) ? rows : [];
}

function jupiterStatsForInterval(row, interval) {
  const key = `stats${interval}`;
  return row?.[key] || row?.stats5m || row?.stats1h || row?.stats24h || {};
}

function normalizeJupiterTrendingRow(row, interval, rank) {
  const stats = jupiterStatsForInterval(row, interval);
  const buyVolume = Number(stats.buyVolume ?? 0);
  const sellVolume = Number(stats.sellVolume ?? 0);
  const numBuys = Number(stats.numBuys ?? 0);
  const numSells = Number(stats.numSells ?? 0);
  const topHolders = Number(row?.audit?.topHoldersPercentage);
  const botHolders = Number(row?.audit?.botHoldersPercentage);
  return {
    ...row,
    address: row?.id,
    price: Number(row?.usdPrice ?? 0),
    volume: buyVolume + sellVolume,
    liquidity: Number(row?.liquidity ?? 0),
    market_cap: Number(row?.mcap ?? row?.fdv ?? 0),
    swaps: numBuys + numSells,
    buys: numBuys,
    sells: numSells,
    holder_count: Number(row?.holderCount ?? 0),
    top_10_holder_rate: Number.isFinite(topHolders) ? topHolders / 100 : null,
    launchpad_platform: row?.launchpad || null,
    launchpad_status: row?.graduatedAt ? '2' : null,
    smart_degen_count: Number(stats.numOrganicBuyers ?? 0),
    hot_level: Number(row?.organicScore ?? 0),
    rug_ratio: null,
    bundler_rate: Number.isFinite(botHolders) ? botHolders / 100 : null,
    source: 'jupiter_toptrending',
    interval,
    rank,
    stats,
  };
}

function trendingSignalPass(row) {
  const volume = Number(row?.volume ?? 0);
  const swaps = Number(row?.swaps ?? 0);
  const rugRatio = Number(row?.rug_ratio ?? 0);
  const bundlerRate = Number(row?.bundler_rate ?? 0);
  const minVolume = numSetting('trending_min_volume_usd', 0);
  const minSwaps = numSetting('trending_min_swaps', 0);
  const maxRugRatio = numSetting('trending_max_rug_ratio', 0.3);
  const maxBundlerRate = numSetting('trending_max_bundler_rate', 0.5);
  if (minVolume > 0 && (!Number.isFinite(volume) || volume < minVolume)) return false;
  if (minSwaps > 0 && (!Number.isFinite(swaps) || swaps < minSwaps)) return false;
  if (maxRugRatio > 0 && Number.isFinite(rugRatio) && rugRatio > maxRugRatio) return false;
  if (maxBundlerRate > 0 && Number.isFinite(bundlerRate) && bundlerRate > maxBundlerRate) return false;
  if (row?.is_wash_trading === true || row?.is_wash_trading === 1) return false;
  return true;
}

async function fetchJupiterTrendingRows(interval, limit) {
  if (!JUPITER_API_KEY) {
    console.log('[trending:jupiter] JUPITER_API_KEY missing');
    return [];
  }
  const supported = new Set(['5m', '1h', '6h', '24h']);
  const window = supported.has(interval) ? interval : '5m';
  const url = new URL(`https://api.jup.ag/tokens/v2/toptrending/${window}`);
  url.searchParams.set('limit', String(limit));
  const res = await axios.get(url.toString(), {
    timeout: 10_000,
    headers: { ...JSON_HEADERS, 'x-api-key': JUPITER_API_KEY },
  });
  const rows = Array.isArray(res.data) ? res.data : [];
  return rows.map((row, index) => normalizeJupiterTrendingRow(row, window, index + 1));
}

async function fetchGmgnTrendingRows(interval, limit) {
  if (gmgnBackoffActive('trending')) return [];
  const payload = await gmgnFetch('/v1/market/rank', {
    params: {
      chain: 'sol',
      interval,
      limit,
      order_by: setting('trending_order_by', 'volume'),
      direction: 'desc',
      filters: ['renounced', 'frozen', 'not_wash_trading'],
      platforms: ['Pump.fun', 'meteora_virtual_curve', 'pool_pump_amm'],
    },
  });
  return normalizedTrendingRows(payload).map((row, index) => ({
    ...row,
    interval,
    rank: index + 1,
    source: 'gmgn_market_rank',
  }));
}

async function fetchGmgnTrending() {
  if (!boolSetting('trending_enabled', true)) {
    trending.clear();
    return;
  }
  const interval = setting('trending_interval', '5m');
  const limit = Math.max(1, Math.min(200, Math.floor(numSetting('trending_limit', 100))));
  const source = setting('trending_source', 'jupiter');

  try {
    const rows = source === 'gmgn'
      ? await fetchGmgnTrendingRows(interval, Math.min(100, limit))
      : await fetchJupiterTrendingRows(interval, limit);
    const seenAt = now();
    const cutoff = seenAt - TRENDING_LOOKBACK_MS;
    for (const [mint, token] of trending) {
      if (Number(token.seenAt || 0) < cutoff) trending.delete(mint);
    }
    let tracked = 0;
    for (const [index, row] of rows.entries()) {
      const mint = row?.address || row?.mint;
      if (!mint || !String(mint).endsWith('pump') || !trendingSignalPass(row)) continue;
      const token = { ...row, address: mint, interval, rank: index + 1, seenAt };
      trending.set(mint, token);
      tracked += 1;
      storeSignalEvent(mint, 'trending', token.source || source, token);
      await maybeProcessDegenCandidate(mint, token);
    }
    console.log(`[trending:${source}] loaded ${rows.length}, accepted ${tracked}, tracking ${trending.size}`);
  } catch (err) {
    if (source === 'gmgn') setGmgnBackoff('trending', err);
    const status = err.response?.status || '';
    const body = err.response?.data;
    const resetAt = body?.reset_at ? ` reset_at=${body.reset_at}` : '';
    if (source !== 'gmgn' || (status !== 403 && status !== 429)) console.log(`[trending:${source}] ${status} ${body?.code || ''} ${body?.message || err.message}${resetAt}`);
  }
}

async function fetchGmgnTokenInfo(mint, useCache = true) {
  const cached = gmgnCache.get(mint);
  if (useCache && cached && now() - cached.at < GMGN_CACHE_TTL_MS) return cached.data;
  if (gmgnBackoffActive('token')) {
    gmgnCache.set(mint, { at: now(), data: null });
    return null;
  }

  try {
    const payload = await gmgnFetch('/v1/token/info', {
      params: { chain: 'sol', address: mint },
    });
    const data = payload?.data?.data || payload?.data || payload;
    gmgnCache.set(mint, { at: now(), data });
    return data;
  } catch (err) {
    setGmgnBackoff('token', err);
    if (err.response?.status !== 403 && err.response?.status !== 429) {
      console.log(`[gmgn] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    }
    gmgnCache.set(mint, { at: now(), data: null });
    return null;
  }
}

async function fetchJupiterAsset(mint, { useCache = true, ttlMs = 20_000 } = {}) {
  const cached = jupiterAssetCache.get(mint);
  if (useCache && cached && now() - cached.at < ttlMs) return cached.data;
  if (jupiterAssetBackoffActive()) return cached?.data || null;
  try {
    const url = new URL('https://datapi.jup.ag/v1/assets/search');
    url.searchParams.set('query', mint);
    const res = await axios.get(url.toString(), {
      timeout: 10_000,
      headers: JSON_HEADERS,
    });
    const rows = Array.isArray(res.data) ? res.data : [];
    const data = rows.find(row => row?.id === mint) || rows[0] || null;
    jupiterAssetCache.set(mint, { at: now(), data });
    return data;
  } catch (err) {
    setJupiterAssetBackoff(err);
    if (err.response?.status !== 429) console.log(`[asset] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    return cached?.data || null;
  }
}

async function fetchSolUsdPrice() {
  try {
    const res = await axios.get(`https://lite-api.jup.ag/price/v3?ids=${WSOL_MINT}`, {
      timeout: 5000,
      headers: JSON_HEADERS,
    });
    const price = Number(res.data?.[WSOL_MINT]?.usdPrice);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch (err) {
    console.log(`[sol-price] ${err.response?.status || ''} ${err.message}`);
    return null;
  }
}

async function estimateTokenAmountFromSol(sizeSol, entryPrice) {
  if (!Number.isFinite(Number(entryPrice)) || Number(entryPrice) <= 0) return null;
  const solUsd = await fetchSolUsdPrice();
  if (!Number.isFinite(Number(solUsd)) || Number(solUsd) <= 0) return null;
  return Number(sizeSol) * solUsd / Number(entryPrice);
}

async function fetchJupiterHolders(mint) {
  try {
    const res = await axios.get(`https://datapi.jup.ag/v1/holders/${mint}`, {
      timeout: 10_000,
      headers: JSON_HEADERS,
    });
    const holders = Array.isArray(res.data?.holders) ? res.data.holders : [];
    const total = holders.reduce((sum, holder) => sum + Number(holder.amount || 0), 0);
    const mapped = holders.map((holder, index) => {
      const pct = total > 0 ? Number(holder.amount || 0) / total * 100 : null;
      return {
        address: holder.address,
        rank: index + 1,
        amount: Number(holder.amount || 0),
        percent: pct,
        tags: (holder.tags || []).map(tag => tag.name || tag.id).filter(Boolean),
      };
    });
    const top20 = mapped.slice(0, 20);
    return {
      count: holders.length,
      holders: mapped,
      top20,
      top20Percent: top20.reduce((sum, holder) => sum + Number(holder.percent || 0), 0),
      maxHolderPercent: Math.max(0, ...top20.map(holder => Number(holder.percent || 0))),
    };
  } catch (err) {
    console.log(`[holders] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    return { count: 0, holders: [], top20: [], top20Percent: null, maxHolderPercent: null };
  }
}

function summarizeCandles(label, candles) {
  if (!candles.length) return { label, available: false };
  const first = candles[0];
  const last = candles[candles.length - 1];
  const high = Math.max(...candles.map(candle => Number(candle.high || 0)));
  const low = Math.min(...candles.map(candle => Number(candle.low || Infinity)));
  const volumeNative = candles.reduce((sum, candle) => sum + Number(candle.volume || 0), 0);
  const current = Number(last.close);
  const start = Number(first.open);
  return {
    label,
    available: true,
    purpose: label === 'ath_context_24h_5m' ? 'ath_context' : 'range_context',
    candles: candles.length,
    fromTime: first.time,
    toTime: last.time,
    current,
    high,
    low,
    volumeNative,
    changePercent: start > 0 ? (current / start - 1) * 100 : null,
    belowHighPercent: high > 0 ? (current / high - 1) * 100 : null,
    aboveLowPercent: low > 0 && Number.isFinite(low) ? (current / low - 1) * 100 : null,
  };
}

async function fetchJupiterChartWindow(mint, interval, candles, label) {
  const url = new URL(`https://datapi.jup.ag/v2/charts/${mint}`);
  url.searchParams.set('interval', interval);
  url.searchParams.set('to', String(now()));
  url.searchParams.set('candles', String(candles));
  url.searchParams.set('type', 'price');
  url.searchParams.set('quote', 'native');
  const res = await axios.get(url.toString(), {
    timeout: 10_000,
    headers: JSON_HEADERS,
  });
  return summarizeCandles(label, Array.isArray(res.data?.candles) ? res.data.candles : []);
}

async function fetchJupiterChartContext(mint) {
  const windows = [
    ['5_MINUTE', 288, 'ath_context_24h_5m'],
    ['1_HOUR', 168, 'swing_7d_1h'],
    ['4_HOUR', 180, 'long_30d_4h'],
  ];
  const results = await Promise.all(windows.map(([interval, candles, label]) => (
    fetchJupiterChartWindow(mint, interval, candles, label).catch((err) => {
      console.log(`[chart] ${mint.slice(0, 8)}... ${interval} ${err.message}`);
      return { label, available: false, error: err.message };
    })
  )));
  const available = results.filter(row => row.available);
  const currentNative = available[0]?.current ?? null;
  const rangeHigh = available.length ? Math.max(...available.map(row => Number(row.high || 0))) : null;
  const topBlastRisk = Number.isFinite(Number(currentNative)) && Number.isFinite(Number(rangeHigh)) && rangeHigh > 0
    ? currentNative / rangeHigh >= 0.85
    : null;
  return {
    quote: 'native',
    purpose: 'ATH/range context, not momentum scoring',
    currentNative,
    rangeHighNative: rangeHigh,
    belowRangeHighPercent: currentNative && rangeHigh ? (currentNative / rangeHigh - 1) * 100 : null,
    distanceFromAthPercent: currentNative && rangeHigh ? (currentNative / rangeHigh - 1) * 100 : null,
    topBlastRisk,
    windows: results,
  };
}

function savedWallets() {
  return db.prepare('SELECT label, address FROM saved_wallets ORDER BY label').all();
}

async function fetchWalletHoldings(address) {
  const res = await axios.get(`https://ultra-api.jup.ag/holdings/${address}`, {
    timeout: 10_000,
    headers: JSON_HEADERS,
  });
  return res.data || {};
}

function matchSavedWalletsFromHolders(holdersResult) {
  const wallets = savedWallets();
  const byAddress = new Map(wallets.map(wallet => [wallet.address, wallet]));
  const holders = [];
  for (const holder of holdersResult?.holders || []) {
    const wallet = byAddress.get(holder.address);
    if (!wallet) continue;
    holders.push({
      ...wallet,
      amount: holder.amount,
      percent: holder.percent,
      rank: holder.rank,
      source: 'holders_api',
    });
  }
  return {
    checked: wallets.length,
    holders,
    holderCount: holders.length,
    source: 'holders_api',
    fallbackChecked: 0,
  };
}

async function fetchSavedWalletExposure(mint, holdersResult = null) {
  const wallets = savedWallets();
  const fromHolders = matchSavedWalletsFromHolders(holdersResult);
  const required = numSetting('min_saved_wallet_holders', 0);
  if (!wallets.length || required <= 0 || fromHolders.holderCount >= required) return fromHolders;

  const matched = new Map(fromHolders.holders.map(holder => [holder.address, holder]));
  let fallbackChecked = 0;
  for (const wallet of wallets) {
    if (matched.has(wallet.address)) continue;
    try {
      fallbackChecked++;
      const data = await fetchWalletHoldings(wallet.address);
      const accounts = Array.isArray(data.tokens?.[mint]) ? data.tokens[mint] : [];
      const amount = accounts.reduce((sum, account) => sum + Number(account.uiAmount || 0), 0);
      if (amount > 0) matched.set(wallet.address, { ...wallet, amount, source: 'holdings_fallback' });
      if (required > 0 && matched.size >= required) break;
    } catch (err) {
      console.log(`[wallet] ${wallet.label} ${err.message}`);
    }
  }
  const holders = [...matched.values()];
  return {
    checked: wallets.length,
    holders,
    holderCount: holders.length,
    source: fallbackChecked ? 'holders_api+holdings_fallback' : 'holders_api',
    fallbackChecked,
  };
}

async function fetchWalletPnl(address) {
  const res = await axios.get(`https://datapi.jup.ag/v1/pnl?addresses=${address}&includeClosed=false`, {
    timeout: 12_000,
    headers: JSON_HEADERS,
  });
  const payload = res.data?.[address] || {};
  const out = [];
  for (const [mint, row] of Object.entries(payload)) {
    if ([SOL_MINT, WSOL_MINT].includes(mint)) continue;
    const balance = row.balance?.balance ?? row.balance?.uiAmount ?? 0;
    const valueUsd = row.balance?.balanceValue ?? 0;
    if (Number(balance) <= 0 && Number(valueUsd) <= 0) continue;
    out.push({
      mint,
      balance: Number(balance),
      valueUsd: Number(valueUsd),
      pnlUsd: Number(row.pnl?.totalPnl ?? 0),
      pnlPercent: Number(row.pnl?.totalPnlPercentage ?? 0),
    });
  }
  return out.sort((a, b) => b.valueUsd - a.valueUsd);
}

function extractTweetUrl(input) {
  const urls = [
    input?.twitter,
    input?.twitter_username,
    input?.link?.twitter_username,
  ].filter(Boolean).map(String);
  const raw = urls.find(url => /(?:^|\/)status\/\d+/.test(url)) || '';
  if (!raw) return null;
  if (raw.startsWith('i/') || raw.startsWith('communities/')) return null;
  if (raw.startsWith('http')) return raw.replace(/^https?:\/\/(www\.)?twitter\.com/i, 'https://x.com');
  return `https://x.com/${raw.replace(/^@/, '')}`;
}

function toFxTwitter(url) {
  return String(url || '')
    .replace(/^https?:\/\/(www\.)?x\.com/i, 'https://fxtwitter.com')
    .replace(/^https?:\/\/(www\.)?twitter\.com/i, 'https://fxtwitter.com');
}

function toFxTwitterApi(url) {
  return String(url || '')
    .replace(/^https?:\/\/(www\.)?x\.com/i, 'https://api.fxtwitter.com')
    .replace(/^https?:\/\/(www\.)?twitter\.com/i, 'https://api.fxtwitter.com');
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractTweetTextFromFx(data) {
  if (!data) return null;
  if (typeof data === 'object') return data.tweet?.text || data.text || null;
  const ogDescription = data.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)?.[1]
    || data.match(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:description["']/i)?.[1];
  if (ogDescription) return decodeHtmlEntities(ogDescription).trim();
  const title = data.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? decodeHtmlEntities(title.replace(/\s+/g, ' ')).trim() : null;
}

function extractTweetMetricsFromFx(data) {
  const tweet = data?.tweet || data;
  if (!tweet || typeof tweet !== 'object') return null;
  return {
    likes: Number(tweet.likes ?? 0),
    retweets: Number(tweet.retweets ?? tweet.reposts ?? 0),
    replies: Number(tweet.replies ?? 0),
    quotes: Number(tweet.quotes ?? 0),
    bookmarks: Number(tweet.bookmarks ?? 0),
    views: tweet.views == null ? null : Number(tweet.views),
    createdAt: tweet.created_at || tweet.date || null,
    createdTimestamp: tweet.created_timestamp || tweet.date_epoch || null,
    authorFollowers: tweet.author?.followers == null ? null : Number(tweet.author.followers),
    authorVerified: Boolean(tweet.author?.verification?.verified || tweet.author?.verified),
    authorScreenName: tweet.author?.screen_name || tweet.user_screen_name || null,
  };
}

function viralityScore(metrics) {
  if (!metrics) return null;
  const views = Number(metrics.views || 0);
  const followers = Number(metrics.authorFollowers || 0);
  const engagement = Number(metrics.likes || 0)
    + Number(metrics.retweets || 0) * 2
    + Number(metrics.quotes || 0) * 2
    + Number(metrics.replies || 0);
  return {
    engagement,
    engagementPerView: views > 0 ? engagement / views * 100 : null,
    engagementPerFollower: followers > 0 ? engagement / followers * 100 : null,
  };
}

async function fetchTwitterNarrative(graduatedCoin, gmgn) {
  const url = extractTweetUrl(graduatedCoin) || extractTweetUrl(gmgn);
  if (!url) return null;
  try {
    const apiUrl = toFxTwitterApi(url);
    const api = await axios.get(apiUrl, {
      timeout: 8000,
      headers: { Accept: 'application/json' },
    });
    const text = extractTweetTextFromFx(api.data);
    const metrics = extractTweetMetricsFromFx(api.data);
    return { url, fxUrl: toFxTwitter(url), apiUrl, text, metrics, virality: viralityScore(metrics) };
  } catch (apiErr) {
    console.log(`[twitter] api ${url} ${apiErr.response?.status || ''} ${apiErr.message}`);
  }

  try {
    const fxUrl = toFxTwitter(url);
    const res = await axios.get(fxUrl, {
      timeout: 8000,
      headers: { Accept: 'text/html,application/json' },
    });
    const text = extractTweetTextFromFx(res.data);
    const metrics = extractTweetMetricsFromFx(res.data);
    return { url, fxUrl, text, metrics, virality: viralityScore(metrics) };
  } catch (err) {
    console.log(`[twitter] ${url} ${err.message}`);
    return { url, fxUrl: toFxTwitter(url), text: null, error: err.message };
  }
}

function buildFeeSnapshot(fee, signature) {
  return {
    mint: fee.mint,
    signature,
    distributedSol: lamToSol(fee.distributed),
    recipients: fee.shareholders.map(holder => ({
      address: holder.pubkey,
      bps: holder.bps,
      percent: holder.bps / 100,
    })),
  };
}

function signalLabel(signals = {}) {
  return [
    signals.hasFeeClaim ? 'fees' : null,
    signals.hasGraduated ? 'graduated' : null,
    signals.hasTrending ? 'trending' : null,
  ].filter(Boolean).join(' + ') || signals.route || 'unknown';
}

function filterCandidate(candidate) {
  const failures = [];
  const mcap = candidate.metrics.marketCapUsd;
  const totalFees = candidate.metrics.gmgnTotalFeesSol;
  const gradVolume = candidate.metrics.graduatedVolumeUsd;
  const maxHolder = candidate.holders.maxHolderPercent;
  const savedCount = candidate.savedWalletExposure.holderCount;
  const feeSol = candidate.feeClaim?.distributedSol;
  const trendingVolume = Number(candidate.trending?.volume ?? 0);
  const trendingSwaps = Number(candidate.trending?.swaps ?? 0);
  const rugRatio = Number(candidate.trending?.rug_ratio ?? 0);
  const bundlerRate = Number(candidate.trending?.bundler_rate ?? 0);

  const checks = [
    ['min_mcap_usd', mcap, value => value <= 0 || mcap >= value, 'market cap min'],
    ['max_mcap_usd', mcap, value => value <= 0 || mcap <= value, 'market cap max'],
    ['min_gmgn_total_fee_sol', totalFees, value => value <= 0 || totalFees >= value, 'GMGN total fees'],
    ['min_graduated_volume_usd', gradVolume, value => value <= 0 || gradVolume >= value, 'graduated volume'],
    ['max_top20_holder_percent', maxHolder, value => value >= 100 || maxHolder <= value, 'max top holder'],
    ['min_saved_wallet_holders', savedCount, value => value <= 0 || savedCount >= value, 'saved wallet holders'],
  ];

  if (candidate.feeClaim) {
    checks.unshift(['min_fee_claim_sol', feeSol, value => value <= 0 || feeSol >= value, 'fee claim SOL']);
  } else if (!boolSetting('trending_allow_degen', false)) {
    failures.push('fee claim: missing');
  }

  if (candidate.trending) {
    checks.push(
      ['trending_min_volume_usd', trendingVolume, value => value <= 0 || trendingVolume >= value, 'trending volume'],
      ['trending_min_swaps', trendingSwaps, value => value <= 0 || trendingSwaps >= value, 'trending swaps'],
      ['trending_max_rug_ratio', rugRatio, value => value <= 0 || !Number.isFinite(rugRatio) || rugRatio <= value, 'trending rug ratio'],
      ['trending_max_bundler_rate', bundlerRate, value => value <= 0 || !Number.isFinite(bundlerRate) || bundlerRate <= value, 'trending bundler rate'],
    );
    if (candidate.trending.is_wash_trading === true || candidate.trending.is_wash_trading === 1) failures.push('trending wash trading');
  }

  for (const [key, actual, predicate, label] of checks) {
    const expected = numSetting(key, key === 'max_top20_holder_percent' ? 100 : 0);
    if (expected > 0 && !Number.isFinite(Number(actual))) {
      failures.push(`${label}: missing`);
    } else if (!predicate(expected)) {
      failures.push(`${label}: ${actual} <filter ${expected}>`);
    }
  }

  return { passed: failures.length === 0, failures };
}

async function buildCandidate({ mint, fee = null, signature = null, graduatedCoin = null, trendingToken = null, route }) {
  const gmgn = await fetchGmgnTokenInfo(mint);
  const jupiterAsset = await fetchJupiterAsset(mint);
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint);
  const savedWalletExposure = await fetchSavedWalletExposure(mint, holders);
  const twitterNarrative = await fetchTwitterNarrative(graduatedCoin || jupiterAsset, gmgn);
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), jupiterAsset?.usdPrice, trendingToken?.price);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    jupiterAsset?.mcap,
    jupiterAsset?.fdv,
    trendingToken?.market_cap,
    graduatedCoin?.marketCap,
    graduatedCoin?.usd_market_cap,
  );
  const signalRoute = route || [
    fee ? 'fee' : null,
    graduatedCoin ? 'graduated' : null,
    trendingToken ? 'trending' : null,
  ].filter(Boolean).join('_');

  const candidate = {
    token: {
      mint,
      name: gmgn?.name || jupiterAsset?.name || trendingToken?.name || graduatedCoin?.name || '',
      symbol: gmgn?.symbol || jupiterAsset?.symbol || trendingToken?.symbol || graduatedCoin?.ticker || '',
      gmgnUrl: gmgn?.link?.gmgn || gmgnLink(mint),
      twitter: graduatedCoin?.twitter || jupiterAsset?.twitter || gmgn?.link?.twitter_username || trendingToken?.twitter || '',
      website: graduatedCoin?.website || jupiterAsset?.website || gmgn?.link?.website || '',
      telegram: graduatedCoin?.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? jupiterAsset?.liquidity ?? trendingToken?.liquidity ?? 0),
      holderCount: Number(gmgn?.holder_count ?? jupiterAsset?.holderCount ?? trendingToken?.holder_count ?? graduatedCoin?.numHolders ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? jupiterAsset?.fees ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? 0),
      graduatedVolumeUsd: Number(graduatedCoin?.volume ?? 0),
      graduatedMarketCapUsd: Number(graduatedCoin?.marketCap ?? 0),
      trendingVolumeUsd: Number(trendingToken?.volume ?? 0),
      trendingSwaps: Number(trendingToken?.swaps ?? 0),
      trendingHotLevel: Number(trendingToken?.hot_level ?? 0),
      trendingSmartDegenCount: Number(trendingToken?.smart_degen_count ?? 0),
    },
    signals: {
      route: signalRoute,
      label: signalLabel({
        hasFeeClaim: Boolean(fee),
        hasGraduated: Boolean(graduatedCoin),
        hasTrending: Boolean(trendingToken),
      }),
      hasFeeClaim: Boolean(fee),
      hasGraduated: Boolean(graduatedCoin),
      hasTrending: Boolean(trendingToken),
      triggerSignature: signature,
    },
    graduation: graduatedCoin,
    trending: trendingToken,
    feeClaim: fee ? buildFeeSnapshot(fee, signature) : null,
    gmgn,
    jupiterAsset,
    holders,
    chart,
    savedWalletExposure,
    twitterNarrative,
    createdAtMs: now(),
  };
  candidate.filters = filterCandidate(candidate);
  return candidate;
}

function candidateSignalKey(candidate, signature = null) {
  if (signature) return `${signature}:${candidate.token.mint}`;
  const route = candidate.signals?.route || 'signal';
  const bucket = Math.floor(Number(candidate.createdAtMs || now()) / (5 * 60 * 1000));
  return `${route}:${candidate.token.mint}:${bucket}`;
}

function upsertCandidate(candidate, signature) {
  const signalKey = candidateSignalKey(candidate, signature);
  const existing = db.prepare('SELECT id FROM candidates WHERE signal_key = ?')
    .get(signalKey);
  if (existing) {
    db.prepare(`
      UPDATE candidates
      SET status = ?, updated_at_ms = ?, candidate_json = ?, filter_result_json = ?
      WHERE id = ?
    `).run(
      candidate.filters.passed ? 'candidate' : 'filtered',
      now(),
      json(candidate),
      json(candidate.filters),
      existing.id,
    );
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO candidates (mint, status, created_at_ms, updated_at_ms, signature, signal_key, candidate_json, filter_result_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidate.token.mint,
    candidate.filters.passed ? 'candidate' : 'filtered',
    now(),
    now(),
    signature,
    signalKey,
    json(candidate),
    json(candidate.filters),
  );
  return Number(result.lastInsertRowid);
}

function updateCandidateStatus(candidateId, status) {
  db.prepare('UPDATE candidates SET status = ?, updated_at_ms = ? WHERE id = ?').run(status, now(), candidateId);
}

function updateCandidateSnapshot(candidateId, candidate, status = null) {
  db.prepare(`
    UPDATE candidates
    SET status = COALESCE(?, status), updated_at_ms = ?, candidate_json = ?, filter_result_json = ?
    WHERE id = ?
  `).run(status, now(), json(candidate), json(candidate.filters || {}), candidateId);
}

function candidateById(id) {
  const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(id);
  return row ? { ...row, candidate: safeJson(row.candidate_json, {}) } : null;
}

function candidatesByIds(ids) {
  return ids.map(id => candidateById(Number(id))).filter(Boolean);
}

function latestCandidateByMint(mint) {
  const row = db.prepare('SELECT * FROM candidates WHERE mint = ? ORDER BY id DESC LIMIT 1').get(mint);
  return row ? { ...row, candidate: safeJson(row.candidate_json, {}) } : null;
}

function batchById(id) {
  const row = db.prepare('SELECT * FROM llm_batches WHERE id = ?').get(id);
  if (!row) return null;
  const candidateIds = safeJson(row.candidate_ids_json, []);
  return {
    ...row,
    candidateIds,
    rows: candidatesByIds(candidateIds),
    decision: {
      verdict: row.verdict,
      confidence: row.confidence,
      reason: row.reason,
      risks: safeJson(row.risks_json, []),
      raw: safeJson(row.raw_json, null),
      selected_candidate_id: row.selected_candidate_id,
      selected_mint: row.selected_mint,
    },
  };
}

function recentEligibleCandidates(limit = 10) {
  const maxAgeMs = numSetting('llm_candidate_max_age_ms', 10 * 60 * 1000);
  const cutoff = now() - Math.max(30_000, maxAgeMs);
  const rows = db.prepare(`
    SELECT *
    FROM candidates
    WHERE status IN ('candidate', 'watch', 'buy', 'pass')
      AND created_at_ms >= ?
      AND id NOT IN (SELECT COALESCE(candidate_id, -1) FROM dry_run_positions WHERE status = 'open')
    ORDER BY id DESC
    LIMIT ?
  `).all(cutoff, limit);
  return rows.map(row => ({ ...row, candidate: safeJson(row.candidate_json, {}) })).reverse();
}

function strictJsonFromText(text) {
  const clean = stripThinking(text);
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = fenced || clean.match(/\{[\s\S]*\}/)?.[0] || clean;
  return JSON.parse(raw);
}

function normalizeDecision(parsed, fallbackReason = '') {
  const verdict = ['BUY', 'WATCH', 'PASS'].includes(String(parsed?.verdict).toUpperCase())
    ? String(parsed.verdict).toUpperCase()
    : 'WATCH';
  return {
    verdict,
    confidence: Math.max(0, Math.min(100, Number(parsed?.confidence) || 0)),
    reason: String(parsed?.reason || fallbackReason).slice(0, 1000),
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String).slice(0, 8) : [],
    suggested_tp_percent: Number(parsed?.suggested_tp_percent) || numSetting('default_tp_percent', 50),
    suggested_sl_percent: Number(parsed?.suggested_sl_percent) || numSetting('default_sl_percent', -25),
    raw: parsed,
  };
}

function activeLessonsForPrompt(limit = 6) {
  return db.prepare(`
    SELECT lesson
    FROM learning_lessons
    WHERE status = 'active'
    ORDER BY id DESC
    LIMIT ?
  `).all(limit).map(row => row.lesson);
}

function compactCandidateForLlm(row) {
  const c = row.candidate;
  const athWindow = c.chart?.windows?.find(window => window.label === 'ath_context_24h_5m' && window.available)
    || c.chart?.windows?.find(window => window.label === 'recent_24h_5m' && window.available);
  return {
    candidate_id: row.id,
    mint: c.token?.mint,
    route: c.signals?.route,
    signals: c.signals,
    token: c.token,
    metrics: c.metrics,
    feeClaim: c.feeClaim,
    trending: c.trending,
    graduation: c.graduation,
    holders: c.holders,
    chart: {
      purpose: 'ATH/range context only. Do not treat large 24h change as bullish/bearish momentum by itself.',
      currentNative: c.chart?.currentNative,
      rangeHighNative: c.chart?.rangeHighNative,
      distanceFromAthPercent: c.chart?.distanceFromAthPercent ?? c.chart?.belowRangeHighPercent,
      topBlastRisk: c.chart?.topBlastRisk,
      athContext24h: athWindow ? {
        current: athWindow.current,
        high: athWindow.high,
        low: athWindow.low,
        distanceFromHighPercent: athWindow.belowHighPercent,
        aboveLowPercent: athWindow.aboveLowPercent,
      } : null,
      windows: c.chart?.windows,
    },
    savedWalletExposure: c.savedWalletExposure,
    twitterNarrative: c.twitterNarrative,
    filters: c.filters,
  };
}

async function decideCandidateBatch(rows, triggerCandidateId) {
  if (!ENABLE_LLM || !LLM_API_KEY) {
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: 'LLM disabled or LLM_API_KEY missing.',
      risks: ['no_llm_decision'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: null,
    };
  }

  const system = [
    'You are Charon, a Solana meme coin trench analyst.',
    'Return strict JSON only.',
    'You will receive up to 10 recently matched candidates.',
    'Pick at most one candidate to buy through the configured execution mode.',
    'Use verdict BUY only for the single best unusually strong asymmetric opportunity.',
    'Use WATCH if candidates are interesting but none deserves a buy.',
    'Use PASS if the set is weak or unsafe.',
    'Chart data is ATH/range context. Do not penalize or reward a token only because 24h change is huge; new Pump tokens often do that.',
    'Use distance from ATH/range high and top-blast risk to decide whether entry is late.',
    'Confidence is your conviction from 0 to 100, not probability.',
  ].join(' ');
  const user = {
    task: 'Pick the best dry-run buy candidate from this recent batch, or choose none.',
    recent_lessons: activeLessonsForPrompt(),
    output_schema: {
      verdict: 'BUY|WATCH|PASS',
      selected_candidate_id: 'integer candidate_id when verdict is BUY, otherwise null',
      selected_mint: 'mint string when verdict is BUY, otherwise null',
      confidence: 'number 0-100',
      reason: 'short string',
      risks: ['short strings'],
      suggested_tp_percent: 'positive number',
      suggested_sl_percent: 'negative number',
    },
    trigger_candidate_id: triggerCandidateId,
    candidates: rows.map(compactCandidateForLlm),
  };

  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    const content = res.data?.choices?.[0]?.message?.content || '';
    const parsed = strictJsonFromText(content);
    const decision = normalizeDecision(parsed);
    const selectedId = Number(parsed.selected_candidate_id);
    const selectedMint = String(parsed.selected_mint || '');
    const row = rows.find(item => item.id === selectedId || item.candidate.token?.mint === selectedMint);
    return {
      ...decision,
      selected_candidate_id: decision.verdict === 'BUY' && row ? row.id : null,
      selected_mint: decision.verdict === 'BUY' && row ? row.candidate.token.mint : null,
      selected_row: decision.verdict === 'BUY' && row ? row : null,
    };
  } catch (err) {
    console.log(`[llm] batch failed: ${err.message}`);
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: `LLM failed: ${err.message}`,
      risks: ['llm_error'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: { error: err.message },
    };
  }
}

async function decideCandidate(candidate) {
  const pseudoRow = { id: 0, candidate };
  const decision = await decideCandidateBatch([pseudoRow], 0);
  return normalizeDecision(decision.raw || decision, decision.reason);
}

function storeDecision(candidateId, candidate, decision) {
  const result = db.prepare(`
    INSERT INTO llm_decisions (candidate_id, mint, created_at_ms, verdict, confidence, reason, risks_json, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId,
    candidate.token.mint,
    now(),
    decision.verdict,
    decision.confidence,
    decision.reason,
    json(decision.risks),
    json(decision.raw || decision),
  );
  return Number(result.lastInsertRowid);
}

function storeBatchDecision(triggerCandidateId, rows, decision) {
  const result = db.prepare(`
    INSERT INTO llm_batches (
      created_at_ms, trigger_candidate_id, selected_candidate_id, selected_mint,
      verdict, confidence, reason, risks_json, raw_json, candidate_ids_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    now(),
    triggerCandidateId,
    decision.selected_candidate_id || null,
    decision.selected_mint || null,
    decision.verdict,
    decision.confidence,
    decision.reason,
    json(decision.risks),
    json(decision.raw || decision),
    json(rows.map(row => row.id)),
  );
  return Number(result.lastInsertRowid);
}

async function freshEntryMarket(mint, candidate) {
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  return { gmgn, asset, priceUsd, marketCapUsd, refreshedAtMs: now() };
}

async function refreshCandidateForExecution(row) {
  const candidate = row.candidate;
  const mint = candidate.token.mint;
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint);
  const selectedTrending = trending.get(mint) || candidate.trending || null;
  const selectedHolders = holders?.holders?.length ? holders : candidate.holders;
  const selectedSavedWalletExposure = selectedHolders
    ? await fetchSavedWalletExposure(mint, selectedHolders)
    : candidate.savedWalletExposure;
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, selectedTrending?.price, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    selectedTrending?.market_cap,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  const refreshed = {
    ...candidate,
    token: {
      ...candidate.token,
      name: gmgn?.name || asset?.name || selectedTrending?.name || candidate.token.name,
      symbol: gmgn?.symbol || asset?.symbol || selectedTrending?.symbol || candidate.token.symbol,
      twitter: candidate.token.twitter || asset?.twitter || gmgn?.link?.twitter_username || selectedTrending?.twitter || '',
      website: candidate.token.website || asset?.website || gmgn?.link?.website || '',
      telegram: candidate.token.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      ...candidate.metrics,
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? candidate.metrics?.liquidityUsd ?? 0),
      holderCount: Number(gmgn?.holder_count ?? asset?.holderCount ?? selectedTrending?.holder_count ?? candidate.metrics?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? asset?.fees ?? candidate.metrics?.gmgnTotalFeesSol ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? candidate.metrics?.gmgnTradeFeesSol ?? 0),
      trendingVolumeUsd: Number(selectedTrending?.volume ?? candidate.metrics?.trendingVolumeUsd ?? 0),
      trendingSwaps: Number(selectedTrending?.swaps ?? candidate.metrics?.trendingSwaps ?? 0),
      trendingHotLevel: Number(selectedTrending?.hot_level ?? candidate.metrics?.trendingHotLevel ?? 0),
      trendingSmartDegenCount: Number(selectedTrending?.smart_degen_count ?? candidate.metrics?.trendingSmartDegenCount ?? 0),
    },
    gmgn,
    jupiterAsset: asset,
    trending: selectedTrending,
    holders: selectedHolders,
    chart,
    savedWalletExposure: selectedSavedWalletExposure,
    executionRefresh: {
      refreshedAtMs: now(),
      source: 'pre_execution',
      marketCapUsd,
      priceUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? 0),
      holdersRefreshed: Boolean(holders?.holders?.length),
    },
  };
  refreshed.filters = filterCandidate(refreshed);
  const executionFailures = [];
  if (!Number.isFinite(Number(refreshed.metrics.marketCapUsd)) || Number(refreshed.metrics.marketCapUsd) <= 0) {
    executionFailures.push('execution mcap: missing');
  }
  if (!Number.isFinite(Number(refreshed.metrics.priceUsd)) || Number(refreshed.metrics.priceUsd) <= 0) {
    executionFailures.push('execution price: missing');
  }
  if (executionFailures.length) {
    refreshed.filters = {
      ...refreshed.filters,
      passed: false,
      failures: [...(refreshed.filters?.failures || []), ...executionFailures],
    };
  }
  updateCandidateSnapshot(row.id, refreshed, refreshed.filters.passed ? 'candidate' : 'filtered');
  return { ...row, candidate: refreshed };
}

async function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy') {
  const sizeSol = numSetting('dry_run_buy_sol', 0.1);
  const fresh = await freshEntryMarket(candidate.token.mint, candidate);
  const entryPrice = Number(fresh.priceUsd || 0) || null;
  const entryMcap = Number(fresh.marketCapUsd || 0) || null;
  const tokenAmount = await estimateTokenAmountFromSol(sizeSol, entryPrice);
  const tp = Number(decision.suggested_tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = boolSetting('default_trailing_enabled', true) ? 1 : 0;
  const trailingPercent = numSetting('default_trailing_percent', 20);
  const existing = db.prepare(`
    SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
  `).get(candidate.token.mint);
  if (existing) return existing.id;

  const result = db.prepare(`
    INSERT INTO dry_run_positions (
      candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
      token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
      trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, snapshot_json
    ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    candidateId,
    candidate.token.mint,
    candidate.token.symbol,
    now(),
    sizeSol,
    entryPrice,
    entryMcap,
    tokenAmount,
    entryPrice,
    entryMcap,
    tp,
    sl,
    trailingEnabled,
    trailingPercent,
    decision.id || null,
    json({ candidate, decision, reason, freshEntryMarket: fresh }),
  );
  const positionId = Number(result.lastInsertRowid);
  db.prepare(`
    INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
    VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
  `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, tokenAmount, reason, json({ candidateId, decision, freshEntryMarket: fresh }));
  db.prepare(`
    INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
  updateCandidateStatus(candidateId, 'dry_bought');
  return positionId;
}

function createLivePosition(candidateId, candidate, decision, swap, reason = 'live_buy') {
  const sizeSol = numSetting('dry_run_buy_sol', 0.1);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(decision.suggested_tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = boolSetting('default_trailing_enabled', true) ? 1 : 0;
  const trailingPercent = numSetting('default_trailing_percent', 20);
  const existing = db.prepare(`
    SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
  `).get(candidate.token.mint);
  if (existing) return existing.id;

  const result = db.prepare(`
    INSERT INTO dry_run_positions (
      candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
      token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
      trailing_enabled, trailing_percent, trailing_armed, llm_decision_id,
      execution_mode, entry_signature, token_amount_raw, snapshot_json
    ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'live', ?, ?, ?)
  `).run(
    candidateId,
    candidate.token.mint,
    candidate.token.symbol,
    now(),
    sizeSol,
    entryPrice,
    entryMcap,
    null,
    entryPrice,
    entryMcap,
    tp,
    sl,
    trailingEnabled,
    trailingPercent,
    decision.id || null,
    swap.signature,
    swap.outputAmount || null,
    json({ candidate, decision, reason, swap }),
  );
  const positionId = Number(result.lastInsertRowid);
  db.prepare(`
    INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
    VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
  `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision, swap }));
  db.prepare(`
    INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
  updateCandidateStatus(candidateId, 'live_bought');
  return positionId;
}

function openPositions() {
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
}

function openPositionCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get('open').count;
}

function canOpenMorePositions() {
  const max = numSetting('max_open_positions', 3);
  if (max <= 0) return true;
  return openPositionCount() < max;
}

function tradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

async function refreshPosition(position, { autoExit = true } = {}) {
  const asset = await fetchJupiterAsset(position.mint);
  const price = firstPositiveNumber(asset?.usdPrice, position.high_water_price, position.entry_price);
  const mcap = firstPositiveNumber(asset?.mcap, asset?.fdv, position.high_water_mcap, position.entry_mcap);
  if (!Number.isFinite(Number(mcap)) || !Number.isFinite(Number(position.entry_mcap)) || Number(position.entry_mcap) <= 0) {
    return null;
  }
  const highWaterMcap = Math.max(Number(position.high_water_mcap || 0), Number(mcap));
  const highWaterPrice = Math.max(Number(position.high_water_price || 0), Number(price || 0));
  const pnlPercent = (Number(mcap) / Number(position.entry_mcap) - 1) * 100;
  const pnlSol = Number(position.size_sol) * pnlPercent / 100;
  const tpHit = pnlPercent >= Number(position.tp_percent);
  const slHit = pnlPercent <= Number(position.sl_percent);
  const trailingArmed = position.trailing_armed || (position.trailing_enabled && tpHit);
  const trailDrop = highWaterMcap > 0 ? (Number(mcap) / highWaterMcap - 1) * 100 : 0;
  const trailingHit = trailingArmed && position.trailing_enabled && trailDrop <= -Math.abs(Number(position.trailing_percent));
  let exitReason = null;
  let closed = false;
  if (slHit) exitReason = 'SL';
  else if (tpHit && !position.trailing_enabled) exitReason = 'TP';
  else if (trailingHit) exitReason = 'TRAILING_TP';

  db.prepare(`
    UPDATE dry_run_positions
    SET high_water_mcap = ?, high_water_price = ?, trailing_armed = ?
    WHERE id = ?
  `).run(highWaterMcap, highWaterPrice, trailingArmed ? 1 : 0, position.id);

  if (exitReason && autoExit && position.execution_mode === 'live') {
    const sell = await executeLiveSell(position, exitReason);
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
          pnl_percent = ?, pnl_sol = ?, exit_signature = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, pnlPercent, pnlSol, sell.signature, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent, pnlSol, sell }));
    closed = true;
  } else if (exitReason && autoExit) {
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?, pnl_percent = ?, pnl_sol = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, pnlPercent, pnlSol, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent, pnlSol }));
    closed = true;
  }
  return {
    ...position,
    status: closed ? 'closed' : position.status,
    closed_at_ms: closed ? now() : position.closed_at_ms,
    asset,
    price,
    mcap,
    highWaterMcap,
    high_water_mcap: highWaterMcap,
    high_water_price: highWaterPrice,
    pnlPercent,
    pnl_percent: pnlPercent,
    pnlSol,
    pnl_sol: pnlSol,
    exitReason: closed ? exitReason : null,
    exit_reason: closed ? exitReason : position.exit_reason,
    exit_mcap: closed ? mcap : position.exit_mcap,
    exit_price: closed ? price : position.exit_price,
  };
}

async function monitorPositions() {
  for (const position of openPositions()) {
    const result = await refreshPosition(position).catch((err) => {
      console.log(`[position] ${position.id} ${err.message}`);
      return null;
    });
    if (result?.exitReason) await sendPositionExit(result);
  }
}

function formatRecipients(shareholders) {
  if (!shareholders?.length) return '';
  return shareholders.slice(0, 5).map((holder, index) => {
    const pct = holder.bps != null ? ` (${fmtPct(holder.bps / 100)})` : '';
    const label = shareholders.length > 1 ? `Recipient ${index + 1}` : 'Recipient';
    return `${label}: <a href="${accountLink(holder.pubkey)}">${short(holder.pubkey)}</a>${pct}`;
  }).join('\n') + '\n';
}

function candidateSummary(candidate, decision = null) {
  const chartWindow = candidate.chart?.windows?.find(row => row.label === 'ath_context_24h_5m' && row.available)
    || candidate.chart?.windows?.find(row => row.label === 'recent_24h_5m' && row.available);
  const route = candidate.signals?.label || signalLabel(candidate.signals);
  const lines = [
    `🛶 <b>Charon Candidate</b>`,
    '',
    `Signal: <b>${escapeHtml(route)}</b>`,
    candidate.token.name || candidate.token.symbol ? `Name: <b>${escapeHtml(candidate.token.name || candidate.token.symbol)}${candidate.token.symbol && candidate.token.name ? ` (${escapeHtml(candidate.token.symbol)})` : ''}</b>` : null,
    `Token: <a href="${gmgnLink(candidate.token.mint)}">${short(candidate.token.mint)}</a>`,
    `<code>${escapeHtml(candidate.token.mint)}</code>`,
    [
      `Mcap: ${fmtUsd(candidate.metrics.marketCapUsd)}`,
      `Liq: ${fmtUsd(candidate.metrics.liquidityUsd)}`,
      `Fees: ${fmtSol(candidate.metrics.gmgnTotalFeesSol)} SOL`,
      `Grad vol: ${fmtUsd(candidate.metrics.graduatedVolumeUsd)}`,
    ].join(' · '),
    [
      `Holders: ${candidate.metrics.holderCount || '?'}`,
      `Top20: ${fmtPct(candidate.holders.top20Percent)}`,
      `Max holder: ${fmtPct(candidate.holders.maxHolderPercent)}`,
      `Saved wallets: ${candidate.savedWalletExposure.holderCount}/${candidate.savedWalletExposure.checked}`,
    ].join(' · '),
    candidate.trending ? [
      `Trending: #${candidate.trending.rank || '?'}/${escapeHtml(candidate.trending.interval || '')}`,
      `Vol: ${fmtUsd(candidate.metrics.trendingVolumeUsd)}`,
      `Swaps: ${candidate.metrics.trendingSwaps || 0}`,
      `Hot: ${candidate.metrics.trendingHotLevel || 0}`,
      `Smart: ${candidate.metrics.trendingSmartDegenCount || 0}`,
    ].join(' · ') : null,
    chartWindow ? [
      `ATH ctx: ${fmtPct(chartWindow.belowHighPercent)} from 24h high`,
      `Range low: ${fmtPct(chartWindow.aboveLowPercent)}`,
      `Top risk: ${candidate.chart.topBlastRisk ? 'yes' : 'no'}`,
    ].join(' · ') : null,
    candidate.twitterNarrative?.metrics ? [
      `Tweet: ${candidate.twitterNarrative.metrics.likes} likes`,
      `${candidate.twitterNarrative.metrics.retweets} RT`,
      `${candidate.twitterNarrative.metrics.replies} replies`,
      `${candidate.twitterNarrative.metrics.quotes} quotes`,
    ].join(' · ') : null,
    candidate.feeClaim ? `Fee claim: <b>${fmtSol(candidate.feeClaim.distributedSol)} SOL</b>` : null,
    candidate.twitterNarrative?.text ? `Narrative: ${escapeHtml(candidate.twitterNarrative.text.slice(0, 220))}` : null,
    decision ? `LLM: <b>${escapeHtml(decision.verdict)}</b> ${fmtPct(decision.confidence)} — ${escapeHtml(decision.reason || '')}` : null,
    candidate.filters.passed ? null : `Filtered: ${escapeHtml(candidate.filters.failures.join('; '))}`,
  ];
  return lines.filter(Boolean).join('\n');
}

function candidateButtons(candidateId, decision = null) {
  const verdict = String(decision?.verdict || '').toUpperCase();
  if (verdict && verdict !== 'BUY') {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: `Skipped: ${verdict}`, callback_data: 'noop' }],
          [
            { text: 'View Candidate', callback_data: `cand:${candidateId}` },
            { text: 'Ignore', callback_data: `ign:${candidateId}` },
          ],
          [{ text: 'Positions', callback_data: 'menu:positions' }],
        ],
      },
    };
  }
  if (verdict === 'BUY') {
    return {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'LLM BUY selected', callback_data: 'noop' }],
          [
            { text: 'View Candidate', callback_data: `cand:${candidateId}` },
            { text: 'Positions', callback_data: 'menu:positions' },
          ],
          [
            { text: 'Set TP/SL', callback_data: `tpsl:c:${candidateId}` },
            { text: 'Ignore', callback_data: `ign:${candidateId}` },
          ],
        ],
      },
    };
  }
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'View Candidate', callback_data: `cand:${candidateId}` },
          { text: 'Dry Buy', callback_data: `buy:${candidateId}` },
        ],
        [
          { text: 'Set TP/SL', callback_data: `tpsl:c:${candidateId}` },
          { text: 'Ignore', callback_data: `ign:${candidateId}` },
        ],
        [{ text: 'Positions', callback_data: 'menu:positions' }],
      ],
    },
  };
}

function compactCandidateLine(row, index = null) {
  const candidate = row.candidate;
  const prefix = index == null ? '' : `${index}. `;
  const name = candidate.token?.symbol || candidate.token?.name || short(candidate.token?.mint || '');
  const signal = candidate.signals?.label || signalLabel(candidate.signals);
  return [
    `${prefix}<b>${escapeHtml(name)}</b>`,
    `<a href="${gmgnLink(candidate.token.mint)}">${short(candidate.token.mint)}</a>`,
    escapeHtml(signal),
    `mcap ${fmtUsd(candidate.metrics?.marketCapUsd)}`,
    `liq ${fmtUsd(candidate.metrics?.liquidityUsd)}`,
    candidate.feeClaim ? `fee ${fmtSol(candidate.feeClaim.distributedSol)} SOL` : null,
  ].filter(Boolean).join(' · ');
}

function batchRevealSummary(batchId, rows, decision, triggerCandidateId = null) {
  const selected = rows.find(row => row.id === Number(decision.selected_candidate_id));
  const trigger = rows.find(row => row.id === Number(triggerCandidateId));
  const lines = [
    '🧭 <b>Charon Screening</b>',
    '',
    `Batch: <b>#${batchId}</b> · Screened: <b>${rows.length}</b>`,
    trigger ? `Trigger: ${compactCandidateLine(trigger)}` : null,
    selected ? `Pick: ${compactCandidateLine(selected)}` : 'Pick: <b>none</b>',
    `Decision: <b>${escapeHtml(decision.verdict || 'WATCH')}</b> ${fmtPct(decision.confidence || 0)}`,
    decision.reason ? `Reason: ${escapeHtml(String(decision.reason).slice(0, 420))}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

function batchRevealButtons(batchId, rows, decision, triggerCandidateId = null) {
  const selectedId = Number(decision.selected_candidate_id || 0);
  const triggerId = Number(triggerCandidateId || 0);
  const keyboard = [];
  if (selectedId) keyboard.push([{ text: 'Reveal Pick', callback_data: `cand:${selectedId}` }]);
  keyboard.push([{ text: 'Reveal Batch', callback_data: `batch:${batchId}` }]);
  if (triggerId && triggerId !== selectedId) keyboard.push([{ text: 'Reveal Trigger', callback_data: `cand:${triggerId}` }]);
  keyboard.push([{ text: 'Positions', callback_data: 'menu:positions' }]);
  return { reply_markup: { inline_keyboard: keyboard } };
}

function positionButtons(positionId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Dry Sell', callback_data: `sell:${positionId}` },
          { text: 'Refresh', callback_data: `pos:${positionId}` },
        ],
        [
          { text: 'TP +25%', callback_data: `tp:${positionId}:25` },
          { text: 'TP +50%', callback_data: `tp:${positionId}:50` },
        ],
        [
          { text: 'SL -15%', callback_data: `sl:${positionId}:-15` },
          { text: 'SL -25%', callback_data: `sl:${positionId}:-25` },
        ],
        [{ text: 'Trail On/Off', callback_data: `trail:${positionId}` }],
      ],
    },
  };
}

async function sendTelegram(text, extra = {}) {
  return bot.sendMessage(TELEGRAM_CHAT_ID, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...extra,
  });
}

async function sendCandidateAlert(candidateId, candidate, decision) {
  const sent = await sendTelegram(candidateSummary(candidate, decision), candidateButtons(candidateId, decision));
  db.prepare(`
    INSERT INTO alerts (candidate_id, mint, kind, sent_at_ms, telegram_message_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(candidateId, candidate.token.mint, 'candidate', now(), sent.message_id, json({ candidate, decision }));
}

async function sendBatchReveal(batchId, rows, decision, triggerCandidateId) {
  const sent = await sendTelegram(
    batchRevealSummary(batchId, rows, decision, triggerCandidateId),
    batchRevealButtons(batchId, rows, decision, triggerCandidateId),
  );
  db.prepare(`
    INSERT INTO alerts (candidate_id, mint, kind, sent_at_ms, telegram_message_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    triggerCandidateId || null,
    decision.selected_mint || rows.find(row => row.id === Number(triggerCandidateId))?.candidate?.token?.mint || 'batch',
    'batch_reveal',
    now(),
    sent.message_id,
    json({ batchId, candidateIds: rows.map(row => row.id), decision, triggerCandidateId }),
  );
}

async function sendBatch(chatId, batchId) {
  const batch = batchById(batchId);
  if (!batch) return bot.sendMessage(chatId, 'Batch not found.');
  const lines = [
    '🧭 <b>Screening Batch</b>',
    '',
    `Batch: <b>#${batchId}</b> · Decision: <b>${escapeHtml(batch.verdict)}</b> ${fmtPct(batch.confidence)}`,
    batch.reason ? `Reason: ${escapeHtml(String(batch.reason).slice(0, 500))}` : null,
    '',
    ...batch.rows.map((row, index) => compactCandidateLine(row, index + 1)),
  ];
  const keyboard = batch.rows.slice(0, 10).map((row, index) => ([{
    text: `${index + 1}. ${row.candidate.token?.symbol || short(row.candidate.token?.mint || '')}`,
    callback_data: `cand:${row.id}`,
  }]));
  keyboard.push([{ text: 'Positions', callback_data: 'menu:positions' }]);
  return bot.sendMessage(chatId, lines.filter(Boolean).join('\n'), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard },
  });
}

function formatPosition(position) {
  const pnl = position.pnl_percent != null
    ? Number(position.pnl_percent)
    : position.entry_mcap && position.high_water_mcap
      ? (Number(position.high_water_mcap) / Number(position.entry_mcap) - 1) * 100
      : 0;
  return [
    `📍 <b>${escapeHtml(position.symbol || short(position.mint))}</b> #${position.id}`,
    `Token: <a href="${gmgnLink(position.mint)}">${short(position.mint)}</a>`,
    `Status: <b>${escapeHtml(position.status)}</b> · Mode: <b>${escapeHtml(position.execution_mode || 'dry_run')}</b>`,
    position.entry_signature ? `Entry TX: <a href="${txLink(position.entry_signature)}">${short(position.entry_signature)}</a>` : null,
    `Entry mcap: ${fmtUsd(position.entry_mcap)} · High: ${fmtUsd(position.high_water_mcap)}`,
    `Size: ${fmtSol(position.size_sol)} SOL · PnL: ${fmtPct(pnl)}`,
    `TP: ${fmtPct(position.tp_percent)} · SL: ${fmtPct(position.sl_percent)} · Trail: ${position.trailing_enabled ? `${fmtPct(position.trailing_percent)}` : 'off'}`,
    position.exit_reason ? `Exit: ${escapeHtml(position.exit_reason)} at ${fmtUsd(position.exit_mcap)} (${fmtPct(position.pnl_percent)})` : null,
    position.exit_signature ? `Exit TX: <a href="${txLink(position.exit_signature)}">${short(position.exit_signature)}</a>` : null,
  ].filter(Boolean).join('\n');
}

async function sendPositionOpen(positionId) {
  const position = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
  const label = position?.execution_mode === 'live' ? 'Live buy executed' : 'Dry-run buy stored';
  if (position) await sendTelegram(`✅ <b>${label}</b>\n\n${formatPosition(position)}`, positionButtons(positionId));
}

async function sendPositionExit(position) {
  const label = position?.execution_mode === 'live' ? 'Live exit' : 'Dry-run exit';
  await sendTelegram(`🏁 <b>${label}: ${escapeHtml(position.exitReason)}</b>\n\n${formatPosition({ ...position, status: 'closed' })}`);
}

function createTradeIntent(candidateId, candidate, decision, mode, status, side = 'buy') {
  const sizeSol = numSetting('dry_run_buy_sol', 0.1);
  const result = db.prepare(`
    INSERT INTO trade_intents (
      candidate_id, mint, mode, status, created_at_ms, updated_at_ms, side,
      size_sol, confidence, reason, llm_decision_id, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId,
    candidate.token.mint,
    mode,
    status,
    now(),
    now(),
    side,
    sizeSol,
    decision.confidence,
    decision.reason,
    decision.id || null,
    json({ candidate, decision, mode, status }),
  );
  return Number(result.lastInsertRowid);
}

function compactDecisionCandidate(row) {
  if (!row) return null;
  const c = row.candidate;
  return {
    candidateId: row.id,
    mint: c.token?.mint,
    route: c.signals?.route,
    signals: c.signals,
    token: c.token,
    metrics: c.metrics,
    feeClaim: c.feeClaim,
    trending: c.trending,
    jupiterAsset: c.jupiterAsset ? {
      liquidity: c.jupiterAsset.liquidity,
      mcap: c.jupiterAsset.mcap,
      fdv: c.jupiterAsset.fdv,
      usdPrice: c.jupiterAsset.usdPrice,
      fees: c.jupiterAsset.fees,
      holderCount: c.jupiterAsset.holderCount,
      audit: c.jupiterAsset.audit,
      stats1h: c.jupiterAsset.stats1h,
      stats24h: c.jupiterAsset.stats24h,
    } : null,
    holders: {
      count: c.holders?.count,
      top20Percent: c.holders?.top20Percent,
      maxHolderPercent: c.holders?.maxHolderPercent,
      top20: c.holders?.top20,
    },
    chart: c.chart,
    savedWalletExposure: c.savedWalletExposure,
    twitterNarrative: c.twitterNarrative,
    filters: c.filters,
    createdAtMs: c.createdAtMs,
  };
}

function logDecisionEvent({
  batchId = null,
  triggerCandidateId = null,
  selectedRow = null,
  rows = [],
  decision = {},
  mode = tradingMode(),
  action,
  guardrails = {},
  execution = {},
}) {
  const selectedCandidate = selectedRow?.candidate || null;
  db.prepare(`
    INSERT INTO decision_logs (
      at_ms, batch_id, trigger_candidate_id, selected_candidate_id, selected_mint,
      mode, action, verdict, confidence, reason, guardrails_json, token_json,
      candidate_json, batch_json, execution_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    now(),
    batchId,
    triggerCandidateId,
    selectedRow?.id || null,
    selectedCandidate?.token?.mint || decision.selected_mint || null,
    mode,
    action,
    decision.verdict || null,
    decision.confidence ?? null,
    decision.reason || null,
    json(guardrails),
    json(selectedCandidate?.token || null),
    json(selectedCandidate || null),
    json(rows.map(compactDecisionCandidate)),
    json(execution),
  );
}

function intentById(id) {
  const row = db.prepare('SELECT * FROM trade_intents WHERE id = ?').get(id);
  return row ? { ...row, payload: safeJson(row.payload_json, {}) } : null;
}

function intentButtons(intentId) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Confirm Buy', callback_data: `intent:${intentId}:confirm` },
          { text: 'Reject', callback_data: `intent:${intentId}:reject` },
        ],
        [{ text: 'Positions', callback_data: 'menu:positions' }],
      ],
    },
  };
}

async function sendTradeIntent(intentId, candidate, decision) {
  await sendTelegram([
    '🧾 <b>Trade intent awaiting confirmation</b>',
    '',
    candidateSummary(candidate, decision),
    '',
    `Size: <b>${fmtSol(numSetting('dry_run_buy_sol', 0.1))} SOL</b>`,
    'Execution: confirmation required before signing.',
  ].join('\n'), intentButtons(intentId));
}

async function executeConfirmedIntent(chatId, intentId) {
  const intent = intentById(intentId);
  if (!intent || intent.status !== 'pending_confirmation') return bot.sendMessage(chatId, 'Pending intent not found.');
  if (!canOpenMorePositions()) {
    return bot.sendMessage(chatId, `Max open positions reached (${openPositionCount()}/${numSetting('max_open_positions', 3)}).`);
  }
  const { decision } = intent.payload;
  try {
    const freshRow = await refreshCandidateForExecution({
      id: intent.candidate_id,
      candidate: intent.payload.candidate,
    });
    if (!freshRow.candidate.filters?.passed) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_stale', now(), intentId);
      return bot.sendMessage(chatId, [
        '🛑 <b>Trade intent rejected on fresh check</b>',
        '',
        candidateSummary(freshRow.candidate, decision),
        '',
        `Failures: ${escapeHtml((freshRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
      ].join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
    }
    const amountLamports = Math.floor(numSetting('dry_run_buy_sol', 0.1) * 1_000_000_000);
    const swap = await executeJupiterSwap({
      inputMint: WSOL_MINT,
      outputMint: freshRow.candidate.token.mint,
      amount: amountLamports,
    });
    const positionId = createLivePosition(intent.candidate_id, freshRow.candidate, decision, swap, `confirmed_intent_${intentId}`);
    db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('executed_live', now(), intentId);
    return sendPositionOpen(positionId);
  } catch (err) {
    db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('execution_failed', now(), intentId);
    return bot.sendMessage(chatId, `Live execution failed: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
}

async function rejectIntent(chatId, intentId) {
  const intent = intentById(intentId);
  if (!intent) return bot.sendMessage(chatId, 'Intent not found.');
  db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected', now(), intentId);
  return bot.sendMessage(chatId, `Rejected trade intent #${intentId}.`);
}

async function executeLiveBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const amountLamports = Math.floor(numSetting('dry_run_buy_sol', 0.1) * 1_000_000_000);
  const balance = await liveWalletBalanceLamports();
  if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
    throw new Error(`Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL including reserve.`);
  }
  const swap = await executeJupiterSwap({
    inputMint: WSOL_MINT,
    outputMint: selectedRow.candidate.token.mint,
    amount: amountLamports,
  });
  const positionId = createLivePosition(selectedRow.id, selectedRow.candidate, decision, swap, `live_batch_${batchId}`);
  logDecisionEvent({
    batchId,
    triggerCandidateId,
    selectedRow,
    rows,
    decision,
    mode: 'live',
    action: 'live_entry_executed',
    guardrails: { balanceLamports: balance, amountLamports, minReserveLamports: LIVE_MIN_SOL_RESERVE_LAMPORTS },
    execution: { positionId, swap },
  });
  await sendPositionOpen(positionId);
}

async function executeLiveSell(position, reason) {
  const amount = position.token_amount_raw || position.token_amount_est;
  if (!amount || Number(amount) <= 0) throw new Error('Live position has no token amount to sell.');
  return executeJupiterSwap({
    inputMint: position.mint,
    outputMint: WSOL_MINT,
    amount,
  });
}

async function handleApprovedBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const mode = tradingMode();
  const freshSelectedRow = await refreshCandidateForExecution(selectedRow);
  const executionRows = rows.map(row => row.id === freshSelectedRow.id ? freshSelectedRow : row);
  if (!freshSelectedRow.candidate.filters?.passed) {
    updateCandidateStatus(freshSelectedRow.id, 'stale_rejected');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'entry_rejected_fresh_filters',
      guardrails: {
        failures: freshSelectedRow.candidate.filters?.failures || [],
        refreshedAtMs: freshSelectedRow.candidate.executionRefresh?.refreshedAtMs,
      },
    });
    await sendTelegram([
      '🛑 <b>Execution rejected on fresh check</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Failures: ${escapeHtml((freshSelectedRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
    ].join('\n'));
    return;
  }

  if (mode === 'dry_run') {
    const positionId = await createDryRunPosition(freshSelectedRow.id, freshSelectedRow.candidate, decision, `llm_batch_${batchId}`);
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'dry_run_entry',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { positionId },
    });
    await sendPositionOpen(positionId);
    return;
  }

  if (mode === 'confirm') {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'pending_confirmation');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'confirm_intent_created',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId },
    });
    await sendTradeIntent(intentId, freshSelectedRow.candidate, decision);
    return;
  }

  try {
    await executeLiveBuy(freshSelectedRow, decision, batchId, executionRows, triggerCandidateId);
  } catch (err) {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'execution_failed');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'live_entry_failed',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId, error: err.message },
    });
    await sendTelegram([
      '🛑 <b>Live trade failed</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Intent #${intentId} stored.`,
      `Error: ${escapeHtml(err.message)}`,
    ].join('\n'));
  }
}

async function processCandidateFromSignals(signals) {
  const candidate = await buildCandidate(signals);
  const signature = signals.signature || null;
  const candidateId = upsertCandidate(candidate, signature);
  if (!candidate.filters.passed) {
    console.log(`[candidate] filtered ${candidate.token.mint.slice(0, 8)}... ${candidate.filters.failures.join('; ')}`);
    return;
  }

  const rows = recentEligibleCandidates(numSetting('llm_candidate_pick_count', 10));
  const batchDecision = await decideCandidateBatch(rows, candidateId);
  const batchId = storeBatchDecision(candidateId, rows, batchDecision);
  const selectedRow = batchDecision.selected_row;
  const selectedThisCandidate = selectedRow?.id === candidateId;
  const currentDecision = selectedThisCandidate
    ? batchDecision
    : {
        ...batchDecision,
        verdict: 'WATCH',
        reason: selectedRow
          ? `Batch #${batchId} screened ${rows.length}; selected ${short(selectedRow.candidate.token.mint)} instead. ${batchDecision.reason || ''}`.trim()
          : `Batch #${batchId} screened ${rows.length}; no buy selected. ${batchDecision.reason || ''}`.trim(),
      };
  const currentDecisionId = storeDecision(candidateId, candidate, currentDecision);
  currentDecision.id = currentDecisionId;
  updateCandidateStatus(candidateId, currentDecision.verdict.toLowerCase());

  if (selectedRow && !selectedThisCandidate) {
    const selectedDecisionId = storeDecision(selectedRow.id, selectedRow.candidate, batchDecision);
    batchDecision.id = selectedDecisionId;
    updateCandidateStatus(selectedRow.id, batchDecision.verdict.toLowerCase());
  } else if (selectedThisCandidate) {
    batchDecision.id = currentDecisionId;
  }

  await sendBatchReveal(batchId, rows, batchDecision, candidateId);

  if (selectedRow && boolSetting('agent_enabled', true) && batchDecision.verdict === 'BUY' && batchDecision.confidence >= numSetting('llm_min_confidence', 75)) {
    if (!canOpenMorePositions()) {
      const max = numSetting('max_open_positions', 3);
      console.log(`[agent] max open positions reached (${openPositionCount()}/${max}), skipping buy ${selectedRow.candidate.token.mint}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId: candidateId,
        selectedRow,
        rows,
        decision: batchDecision,
        action: 'entry_skipped_max_positions',
        guardrails: { maxOpenPositions: max, openPositions: openPositionCount() },
      });
      return;
    }
    await handleApprovedBuy(selectedRow, batchDecision, batchId, rows, candidateId);
  } else {
    logDecisionEvent({
      batchId,
      triggerCandidateId: candidateId,
      selectedRow,
      rows,
      decision: batchDecision,
      action: selectedRow ? 'entry_not_approved' : 'no_candidate_selected',
      guardrails: {
        agentEnabled: boolSetting('agent_enabled', true),
        confidenceThreshold: numSetting('llm_min_confidence', 75),
        openPositions: openPositionCount(),
        maxOpenPositions: numSetting('max_open_positions', 3),
      },
    });
  }
}

async function maybeProcessDegenCandidate(mint, trendingToken) {
  if (!boolSetting('trending_allow_degen', false)) return;
  const graduatedCoin = graduated.get(mint);
  if (!graduatedCoin) return;
  pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
  const bucket = Math.floor(now() / (5 * 60 * 1000));
  const key = `graduated_trending:${mint}:${bucket}`;
  if (seenSignalCandidates.has(key)) return;
  seenSignalCandidates.set(key, now());
  await processCandidateFromSignals({
    mint,
    graduatedCoin,
    trendingToken,
    route: 'graduated_trending',
  });
}

async function handleFeeClaim(fee, signature) {
  const sol = lamToSol(fee.distributed);
  if (sol < numSetting('min_fee_claim_sol', 2)) return;
  const graduatedCoin = graduated.get(fee.mint) || null;
  const trendingToken = boolSetting('trending_enabled', true) ? trending.get(fee.mint) || null : null;
  if (!graduatedCoin && !trendingToken) return;

  const key = `${signature}:${fee.mint}:${fee.distributed}`;
  pruneSeen(seenFeeClaims, 10 * 60 * 1000);
  if (seenFeeClaims.has(key)) return;
  seenFeeClaims.set(key, now());
  storeSignalEvent(fee.mint, 'fee_claim', 'pump_logs', { signature, fee: buildFeeSnapshot(fee, signature) });
  const route = graduatedCoin && trendingToken
    ? 'fee_graduated_trending'
    : graduatedCoin
      ? 'fee_graduated'
      : 'fee_trending';
  await processCandidateFromSignals({
    mint: fee.mint,
    fee,
    signature,
    graduatedCoin,
    trendingToken,
    route,
  });
}

async function processLog(logInfo) {
  const { signature, logs, err } = logInfo;
  if (err || !logs) return;
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    let data;
    try {
      data = Buffer.from(line.slice('Program data: '.length), 'base64');
    } catch {
      continue;
    }
    if (data.length < 8 || !discMatch(data, DISC_DIST_FEES)) continue;
    try {
      await handleFeeClaim(parseDistFees(data), signature);
    } catch (error) {
      console.log(`[fee] parse/alert failed: ${error.message}`);
    }
  }
}

function startWebsocket() {
  const wsUrl = SOLANA_WS_URL;
  let ws;
  let pingTimer;
  function connect() {
    ws = new WebSocket(wsUrl);
    ws.on('open', () => {
      console.log('[ws] connected');
      for (const [id, program] of [[1, PUMP_PROGRAM], [2, PUMP_AMM]]) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'logsSubscribe',
          params: [{ mentions: [program] }, { commitment: 'confirmed' }],
        }));
      }
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 30_000);
    });
    ws.on('message', raw => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const value = msg.params?.result?.value;
      if (msg.method === 'logsNotification' && value) {
        processLog(value).catch(error => console.log(`[ws] process failed: ${error.message}`));
      }
    });
    ws.on('close', () => {
      clearInterval(pingTimer);
      console.log('[ws] closed, reconnecting in 5s');
      setTimeout(connect, 5000);
    });
    ws.on('error', error => console.log(`[ws] ${error.message}`));
  }
  connect();
}

function menuKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Agent', callback_data: 'menu:agent' },
          { text: 'Filters', callback_data: 'menu:filters' },
          { text: 'Wallets', callback_data: 'menu:wallets' },
        ],
        [
          { text: 'Positions', callback_data: 'menu:positions' },
          { text: 'PnL', callback_data: 'menu:pnl' },
          { text: 'Settings', callback_data: 'menu:settings' },
        ],
      ],
    },
  };
}

function filtersText() {
  return [
    '⚙️ <b>Charon Filters</b>',
    `Min fee claim: ${fmtSol(numSetting('min_fee_claim_sol', 2))} SOL`,
    `Min mcap: ${fmtUsd(numSetting('min_mcap_usd', 0))}`,
    `Max mcap: ${numSetting('max_mcap_usd', 0) > 0 ? fmtUsd(numSetting('max_mcap_usd', 0)) : 'off'}`,
    `Min fees: ${fmtSol(numSetting('min_gmgn_total_fee_sol', 0))} SOL`,
    `Min grad volume: ${fmtUsd(numSetting('min_graduated_volume_usd', 0))}`,
    `Max holder: ${fmtPct(numSetting('max_top20_holder_percent', 100))}`,
    `Min saved holders: ${numSetting('min_saved_wallet_holders', 0)}`,
    '',
    `Trending: <b>${boolSetting('trending_enabled', true) ? 'on' : 'off'}</b> · Source: <b>${escapeHtml(setting('trending_source', 'jupiter'))}</b> · Degen grad+trend: <b>${boolSetting('trending_allow_degen', false) ? 'on' : 'off'}</b>`,
    `GMGN status: token-info ${escapeHtml(gmgnStatusText('token'))} · trending ${escapeHtml(gmgnStatusText('trending'))}`,
    `Trending interval: ${escapeHtml(setting('trending_interval', '5m'))} · Limit: ${numSetting('trending_limit', 100)} · Order: ${escapeHtml(setting('trending_order_by', 'volume'))}`,
    `Min trend volume: ${fmtUsd(numSetting('trending_min_volume_usd', 0))} · Min swaps: ${numSetting('trending_min_swaps', 0)}`,
    `Max trend rug: ${fmtPct(numSetting('trending_max_rug_ratio', 0.3) * 100)} · Max bundler: ${fmtPct(numSetting('trending_max_bundler_rate', 0.5) * 100)}`,
  ].join('\n');
}

const numericFilterLabels = {
  min_fee_claim_sol: 'minimum fee claim SOL',
  min_mcap_usd: 'minimum mcap USD',
  max_mcap_usd: 'maximum mcap USD',
  min_gmgn_total_fee_sol: 'minimum GMGN fees SOL',
  min_graduated_volume_usd: 'minimum graduated volume USD',
  max_top20_holder_percent: 'maximum holder percent',
  min_saved_wallet_holders: 'minimum saved-wallet holders',
  trending_limit: 'GMGN trending result limit',
  trending_min_volume_usd: 'minimum GMGN trending volume USD',
  trending_min_swaps: 'minimum GMGN trending swaps',
  trending_max_rug_ratio: 'maximum GMGN trending rug ratio (0.3 = 30%)',
  trending_max_bundler_rate: 'maximum GMGN trending bundler rate (0.5 = 50%)',
};

function filtersKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Fee 2 SOL', callback_data: 'set:min_fee_claim_sol:2' },
          { text: 'Fee 5 SOL', callback_data: 'set:min_fee_claim_sol:5' },
          { text: 'Fee 10 SOL', callback_data: 'set:min_fee_claim_sol:10' },
        ],
        [
          { text: 'Mcap >25K', callback_data: 'set:min_mcap_usd:25000' },
          { text: 'Mcap >50K', callback_data: 'set:min_mcap_usd:50000' },
          { text: 'Mcap Off', callback_data: 'set:min_mcap_usd:0' },
        ],
        [
          { text: 'Max Mcap 100K', callback_data: 'set:max_mcap_usd:100000' },
          { text: 'Max Mcap 250K', callback_data: 'set:max_mcap_usd:250000' },
          { text: 'Max Mcap Off', callback_data: 'set:max_mcap_usd:0' },
        ],
        [
          { text: 'GMGN Fees 5 SOL', callback_data: 'set:min_gmgn_total_fee_sol:5' },
          { text: 'GMGN Fees 10 SOL', callback_data: 'set:min_gmgn_total_fee_sol:10' },
          { text: 'GMGN Fees Off', callback_data: 'set:min_gmgn_total_fee_sol:0' },
        ],
        [
          { text: 'Grad Vol 50K', callback_data: 'set:min_graduated_volume_usd:50000' },
          { text: 'Grad Vol 100K', callback_data: 'set:min_graduated_volume_usd:100000' },
          { text: 'Grad Vol Off', callback_data: 'set:min_graduated_volume_usd:0' },
        ],
        [
          { text: 'Max Holder 20%', callback_data: 'set:max_top20_holder_percent:20' },
          { text: 'Max Holder 35%', callback_data: 'set:max_top20_holder_percent:35' },
          { text: 'Holder Off', callback_data: 'set:max_top20_holder_percent:100' },
        ],
        [
          { text: 'Saved 1+', callback_data: 'set:min_saved_wallet_holders:1' },
          { text: 'Saved Off', callback_data: 'set:min_saved_wallet_holders:0' },
          { text: 'Back', callback_data: 'menu:main' },
        ],
        [
          { text: 'Input Fee', callback_data: 'input:min_fee_claim_sol' },
          { text: 'Input Min Mcap', callback_data: 'input:min_mcap_usd' },
          { text: 'Input Max Mcap', callback_data: 'input:max_mcap_usd' },
        ],
        [
          { text: 'Input GMGN Fees', callback_data: 'input:min_gmgn_total_fee_sol' },
          { text: 'Input Grad Vol', callback_data: 'input:min_graduated_volume_usd' },
        ],
        [
          { text: 'Input Max Holder', callback_data: 'input:max_top20_holder_percent' },
          { text: 'Input Saved', callback_data: 'input:min_saved_wallet_holders' },
        ],
        [
          { text: 'Trend On/Off', callback_data: 'toggle:trending_enabled' },
          { text: 'Degen On/Off', callback_data: 'toggle:trending_allow_degen' },
          { text: 'Use Jupiter', callback_data: 'set:trending_source:jupiter' },
        ],
        [
          { text: 'Use GMGN', callback_data: 'set:trending_source:gmgn' },
          { text: 'Trend 5m', callback_data: 'set:trending_interval:5m' },
          { text: 'Trend 1h', callback_data: 'set:trending_interval:1h' },
        ],
        [
          { text: 'Trend 6h', callback_data: 'set:trending_interval:6h' },
          { text: 'Trend Vol', callback_data: 'input:trending_min_volume_usd' },
          { text: 'Trend Swaps', callback_data: 'input:trending_min_swaps' },
        ],
        [
          { text: 'Trend Limit', callback_data: 'input:trending_limit' },
          { text: 'Max Rug', callback_data: 'input:trending_max_rug_ratio' },
          { text: 'Max Bundler', callback_data: 'input:trending_max_bundler_rate' },
        ],
      ],
    },
  };
}

function agentText() {
  return [
    '🛶 <b>Charon Agent</b>',
    `Agent: <b>${boolSetting('agent_enabled', true) ? 'on' : 'off'}</b>`,
    `Mode: <b>${escapeHtml(tradingMode())}</b>`,
    `LLM: <b>${ENABLE_LLM && LLM_API_KEY ? 'configured' : 'disabled/missing key'}</b>`,
    `Confidence: ${fmtPct(numSetting('llm_min_confidence', 75))}`,
    `Open positions: ${openPositionCount()}/${numSetting('max_open_positions', 3) || 'unlimited'}`,
    `Batch candidates: ${numSetting('llm_candidate_pick_count', 10)}`,
    `Candidate freshness: ${Math.round(numSetting('llm_candidate_max_age_ms', 600000) / 1000)}s`,
    `Dry size: ${fmtSol(numSetting('dry_run_buy_sol', 0.1))} SOL`,
    `Default TP/SL: ${fmtPct(numSetting('default_tp_percent', 50))} / ${fmtPct(numSetting('default_sl_percent', -25))}`,
    `Trailing: ${boolSetting('default_trailing_enabled', true) ? fmtPct(numSetting('default_trailing_percent', 20)) : 'off'}`,
  ].join('\n');
}

function agentKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Toggle Agent', callback_data: 'toggle:agent' }],
        [
          { text: 'Dry Run', callback_data: 'set:trading_mode:dry_run' },
          { text: 'Confirm', callback_data: 'set:trading_mode:confirm' },
          { text: 'Live', callback_data: 'set:trading_mode:live' },
        ],
        [
          { text: 'Max Pos 1', callback_data: 'set:max_open_positions:1' },
          { text: 'Max Pos 3', callback_data: 'set:max_open_positions:3' },
          { text: 'Max Pos 5', callback_data: 'set:max_open_positions:5' },
        ],
        [
          { text: 'Batch 5', callback_data: 'set:llm_candidate_pick_count:5' },
          { text: 'Batch 10', callback_data: 'set:llm_candidate_pick_count:10' },
        ],
        [
          { text: 'Fresh 5m', callback_data: 'set:llm_candidate_max_age_ms:300000' },
          { text: 'Fresh 10m', callback_data: 'set:llm_candidate_max_age_ms:600000' },
          { text: 'Fresh 20m', callback_data: 'set:llm_candidate_max_age_ms:1200000' },
        ],
        [{ text: 'Back', callback_data: 'menu:main' }],
      ],
    },
  };
}

async function sendMenu(chatId = TELEGRAM_CHAT_ID) {
  await bot.sendMessage(chatId, `🛶 <b>Charon</b>\nDry-run trench agent online.`, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...menuKeyboard(),
  });
}

async function answerCallback(query, text = '') {
  await bot.answerCallbackQuery(query.id, text ? { text } : undefined).catch(() => {});
}

async function handleCallback(query) {
  const data = query.data || '';
  const chatId = query.message?.chat?.id || TELEGRAM_CHAT_ID;
  await answerCallback(query);

  if (data === 'menu:main') return sendMenu(chatId);
  if (data === 'noop') return null;
  if (data === 'menu:agent') {
    return bot.sendMessage(chatId, agentText(), {
      parse_mode: 'HTML',
      ...agentKeyboard(),
    });
  }
  if (data === 'toggle:agent') {
    setSetting('agent_enabled', boolSetting('agent_enabled', true) ? 'false' : 'true');
    return bot.sendMessage(chatId, agentText(), { parse_mode: 'HTML' });
  }
  if (data === 'toggle:trending_enabled' || data === 'toggle:trending_allow_degen') {
    const key = data.replace('toggle:', '');
    setSetting(key, boolSetting(key, key === 'trending_enabled') ? 'false' : 'true');
    return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML', ...filtersKeyboard() });
  }
  if (data === 'menu:filters') return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML', ...filtersKeyboard() });
  if (data === 'menu:wallets') {
    const rows = savedWallets();
    const body = rows.length
      ? rows.map(row => `• <b>${escapeHtml(row.label)}</b>: <code>${escapeHtml(row.address)}</code>`).join('\n')
      : 'No saved wallets. Use /walletadd &lt;label&gt; &lt;address&gt;';
    return bot.sendMessage(chatId, `👛 <b>Saved Wallets</b>\n\n${body}`, { parse_mode: 'HTML' });
  }
  if (data === 'menu:positions') return sendPositions(chatId);
  if (data === 'menu:pnl') return sendPnl(chatId);
  if (data === 'menu:settings') return bot.sendMessage(chatId, `${agentText()}\n\n${filtersText()}`, { parse_mode: 'HTML' });

  const [kind, id, value] = data.split(':');
  if (kind === 'input') return requestNumericFilterInput(chatId, id);
  if (kind === 'set') return updateSettingFromButton(chatId, id, value);
  if (kind === 'batch') return sendBatch(chatId, Number(id));
  if (kind === 'intent') {
    if (value === 'confirm') return executeConfirmedIntent(chatId, Number(id));
    if (value === 'reject') return rejectIntent(chatId, Number(id));
  }
  if (kind === 'cand') return sendCandidate(chatId, Number(id));
  if (kind === 'ign') {
    updateCandidateStatus(Number(id), 'ignored');
    return bot.sendMessage(chatId, 'Ignored candidate.');
  }
  if (kind === 'buy') {
    const row = candidateById(Number(id));
    if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
    if (!canOpenMorePositions()) {
      return bot.sendMessage(chatId, `Max open positions reached (${openPositionCount()}/${numSetting('max_open_positions', 3)}). Close one first or raise the limit.`);
    }
    const candidate = row.candidate;
    const decision = { verdict: 'BUY', confidence: 100, reason: 'Manual dry buy', risks: [], suggested_tp_percent: numSetting('default_tp_percent', 50), suggested_sl_percent: numSetting('default_sl_percent', -25) };
    const decisionId = storeDecision(row.id, candidate, decision);
    decision.id = decisionId;
    if (tradingMode() === 'live') {
      await executeLiveBuy(row, decision, 'manual', [row], row.id);
      return;
    }
    const positionId = await createDryRunPosition(row.id, candidate, decision, 'manual_buy');
    logDecisionEvent({
      batchId: 'manual',
      triggerCandidateId: row.id,
      selectedRow: row,
      rows: [row],
      decision,
      mode: tradingMode(),
      action: 'manual_dry_run_entry',
      execution: { positionId },
    });
    return sendPositionOpen(positionId);
  }
  if (kind === 'tpsl') return sendTpSlDefaults(chatId);
  if (kind === 'pos') return sendPosition(chatId, Number(id));
  if (kind === 'sell') return closePosition(chatId, Number(id), 'MANUAL');
  if (kind === 'tp') return updatePositionRule(chatId, Number(id), 'tp_percent', Number(value));
  if (kind === 'sl') return updatePositionRule(chatId, Number(id), 'sl_percent', Number(value));
  if (kind === 'trail') return toggleTrailing(chatId, Number(id));
  return null;
}

async function sendCandidate(chatId, id) {
  const row = candidateById(id);
  if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
  const decision = db.prepare('SELECT * FROM llm_decisions WHERE candidate_id = ? ORDER BY id DESC LIMIT 1').get(id);
  await bot.sendMessage(chatId, candidateSummary(row.candidate, decision), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...candidateButtons(id, decision),
  });
}

async function sendTpSlDefaults(chatId) {
  await bot.sendMessage(chatId, agentText(), {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Default TP +25%', callback_data: 'set:default_tp_percent:25' },
          { text: 'Default TP +50%', callback_data: 'set:default_tp_percent:50' },
        ],
        [
          { text: 'Default SL -15%', callback_data: 'set:default_sl_percent:-15' },
          { text: 'Default SL -25%', callback_data: 'set:default_sl_percent:-25' },
        ],
        [
          { text: 'Trail On', callback_data: 'set:default_trailing_enabled:true' },
          { text: 'Trail Off', callback_data: 'set:default_trailing_enabled:false' },
        ],
        [{ text: 'Back', callback_data: 'menu:main' }],
      ],
    },
  });
}

async function sendPositions(chatId) {
  const rows = allPositions(12);
  const text = rows.length ? rows.map(formatPosition).join('\n\n') : 'No dry-run positions yet.';
  await bot.sendMessage(chatId, `📍 <b>Positions</b>\n\n${text}`, { parse_mode: 'HTML', disable_web_page_preview: true });
}

async function sendPosition(chatId, id) {
  let row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return bot.sendMessage(chatId, 'Position not found.');
  if (row.status === 'open') {
    const refreshed = await refreshPosition(row, { autoExit: row.execution_mode !== 'live' }).catch((err) => {
      console.log(`[position] refresh ${id} ${err.message}`);
      return null;
    });
    if (refreshed) row = { ...row, ...refreshed };
  }
  const buttons = row.status === 'open' ? positionButtons(id) : {};
  await bot.sendMessage(chatId, formatPosition(row), { parse_mode: 'HTML', disable_web_page_preview: true, ...buttons });
}

async function closePosition(chatId, id, reason) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row || row.status !== 'open') return bot.sendMessage(chatId, 'Open position not found.');
  const result = await refreshPosition(row, { autoExit: false });
  const price = result?.price ?? row.high_water_price ?? row.entry_price;
  const mcap = result?.mcap ?? row.high_water_mcap ?? row.entry_mcap;
  const pnlPercent = row.entry_mcap ? (Number(mcap) / Number(row.entry_mcap) - 1) * 100 : 0;
  const pnlSol = Number(row.size_sol) * pnlPercent / 100;
  let sell = null;
  if (row.execution_mode === 'live') sell = await executeLiveSell(row, reason);
  db.prepare(`
    UPDATE dry_run_positions
    SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
        pnl_percent = ?, pnl_sol = ?, exit_signature = ?
    WHERE id = ?
  `).run(now(), price, mcap, reason, pnlPercent, pnlSol, sell?.signature || null, id);
  db.prepare(`
    INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
    VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, row.mint, now(), price, mcap, row.size_sol, row.token_amount_est, reason, json({ pnlPercent, pnlSol, sell }));
  const label = row.execution_mode === 'live' ? 'Closed live position' : 'Closed dry-run position';
  await bot.sendMessage(chatId, `${label} #${id}: ${escapeHtml(reason)} ${fmtPct(pnlPercent)}`, { parse_mode: 'HTML' });
}

async function updatePositionRule(chatId, id, field, nextValue) {
  if (!Number.isFinite(nextValue)) return bot.sendMessage(chatId, 'Invalid value.');
  db.prepare(`UPDATE dry_run_positions SET ${field} = ? WHERE id = ?`).run(nextValue, id);
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (row) {
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(position_id) DO UPDATE SET
        tp_percent = excluded.tp_percent,
        sl_percent = excluded.sl_percent,
        trailing_enabled = excluded.trailing_enabled,
        trailing_percent = excluded.trailing_percent,
        updated_at_ms = excluded.updated_at_ms
    `).run(id, row.tp_percent, row.sl_percent, row.trailing_enabled, row.trailing_percent, now());
  }
  await sendPosition(chatId, id);
}

async function toggleTrailing(chatId, id) {
  const row = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(id);
  if (!row) return bot.sendMessage(chatId, 'Position not found.');
  const next = row.trailing_enabled ? 0 : 1;
  db.prepare('UPDATE dry_run_positions SET trailing_enabled = ? WHERE id = ?').run(next, id);
  db.prepare(`
    INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(position_id) DO UPDATE SET
      tp_percent = excluded.tp_percent,
      sl_percent = excluded.sl_percent,
      trailing_enabled = excluded.trailing_enabled,
      trailing_percent = excluded.trailing_percent,
      updated_at_ms = excluded.updated_at_ms
  `).run(id, row.tp_percent, row.sl_percent, next, row.trailing_percent, now());
  await sendPosition(chatId, id);
}

async function updateSettingFromButton(chatId, key, value) {
  const valid = new Set([
    'min_fee_claim_sol',
    'min_mcap_usd',
    'max_mcap_usd',
    'min_gmgn_total_fee_sol',
    'min_graduated_volume_usd',
    'max_top20_holder_percent',
    'min_saved_wallet_holders',
    'trending_enabled',
    'trending_source',
    'trending_allow_degen',
    'trending_interval',
    'trending_limit',
    'trending_order_by',
    'trending_min_volume_usd',
    'trending_min_swaps',
    'trending_max_rug_ratio',
    'trending_max_bundler_rate',
    'trading_mode',
    'llm_min_confidence',
    'llm_candidate_pick_count',
    'llm_candidate_max_age_ms',
    'max_open_positions',
    'dry_run_buy_sol',
    'default_tp_percent',
    'default_sl_percent',
    'default_trailing_enabled',
    'default_trailing_percent',
  ]);
  if (!valid.has(key) || value == null) return bot.sendMessage(chatId, 'Unknown setting.');
  setSetting(key, value);
  const text = key.startsWith('default_') || key === 'dry_run_buy_sol' || key === 'trading_mode' || key === 'llm_min_confidence' || key === 'llm_candidate_pick_count' || key === 'llm_candidate_max_age_ms' || key === 'max_open_positions'
    ? agentText()
    : filtersText();
  const extra = key.startsWith('default_') || key === 'dry_run_buy_sol' || key === 'trading_mode' || key === 'llm_min_confidence' || key === 'llm_candidate_pick_count' || key === 'llm_candidate_max_age_ms' || key === 'max_open_positions'
    ? agentKeyboard()
    : filtersKeyboard();
  return bot.sendMessage(chatId, text, { parse_mode: 'HTML', ...extra });
}

async function requestNumericFilterInput(chatId, key) {
  if (!numericFilterLabels[key]) return bot.sendMessage(chatId, 'Unknown numeric filter.');
  pendingNumericInputs.set(String(chatId), { key, at: now() });
  return bot.sendMessage(
    chatId,
    `Send a number for ${numericFilterLabels[key]}.\nExamples: 5, 50000, 100k, 1.5m, off`,
  );
}

function parseNumericInput(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[$,%\s,_]/g, '');
  if (raw === 'off' || raw === 'none' || raw === 'disable') return 0;
  const match = raw.match(/^(-?\d+(?:\.\d+)?)([kmb])?$/);
  if (!match) return null;
  const multipliers = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
  const parsed = Number(match[1]) * (multipliers[match[2]] || 1);
  return Number.isFinite(parsed) ? parsed : null;
}

async function consumeNumericFilterInput(chatId, text) {
  const pending = pendingNumericInputs.get(String(chatId));
  if (!pending) return false;
  if (now() - pending.at > 5 * 60 * 1000) {
    pendingNumericInputs.delete(String(chatId));
    await bot.sendMessage(chatId, 'That input expired. Tap the filter input button again.');
    return true;
  }
  const value = parseNumericInput(text);
  if (value == null) {
    await bot.sendMessage(chatId, 'Invalid number. Try 5, 50000, 100k, 1.5m, or off.');
    return true;
  }
  pendingNumericInputs.delete(String(chatId));
  setSetting(pending.key, String(value));
  await bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML', ...filtersKeyboard() });
  return true;
}

async function sendPnl(chatId) {
  const wallets = savedWallets();
  if (!wallets.length) return bot.sendMessage(chatId, 'No saved wallets. Use /walletadd <label> <address>.');
  const chunks = [];
  for (const wallet of wallets) {
    try {
      const rows = await fetchWalletPnl(wallet.address);
      const lines = rows.slice(0, 8).map(row => `${short(row.mint)} value ${fmtUsd(row.valueUsd)} pnl ${fmtUsd(row.pnlUsd)} (${fmtPct(row.pnlPercent)})`);
      chunks.push(`<b>${escapeHtml(wallet.label)}</b>\n${lines.join('\n') || 'No open non-SOL positions.'}`);
    } catch (err) {
      chunks.push(`<b>${escapeHtml(wallet.label)}</b>\nError: ${escapeHtml(err.message)}`);
    }
  }
  await bot.sendMessage(chatId, `📊 <b>PnL</b>\n\n${chunks.join('\n\n')}`, { parse_mode: 'HTML' });
}

function parseWindowMs(value = '12h') {
  const raw = String(value || '12h').trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)(m|h|d)?$/);
  if (!match) return 12 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = match[2] || 'h';
  const multipliers = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };
  return Math.max(5 * 60_000, Math.min(30 * 24 * 60 * 60_000, amount * multipliers[unit]));
}

function formatWindow(ms) {
  if (ms % (24 * 60 * 60_000) === 0) return `${ms / (24 * 60 * 60_000)}d`;
  if (ms % (60 * 60_000) === 0) return `${ms / (60 * 60_000)}h`;
  return `${Math.round(ms / 60_000)}m`;
}

function positionSnapshotCandidate(position) {
  return safeJson(position.snapshot_json, {})?.candidate || {};
}

function summarizeLearningWindow(windowMs) {
  const cutoff = now() - windowMs;
  const positions = db.prepare(`
    SELECT *
    FROM dry_run_positions
    WHERE opened_at_ms >= ?
      AND COALESCE(execution_mode, 'dry_run') = 'dry_run'
    ORDER BY opened_at_ms ASC
  `).all(cutoff);
  const closed = positions.filter(position => position.status === 'closed');
  const winners = closed.filter(position => Number(position.pnl_percent || 0) > 0);
  const losers = closed.filter(position => Number(position.pnl_percent || 0) < 0);
  const totalPnlPercent = closed.reduce((sum, position) => sum + Number(position.pnl_percent || 0), 0);
  const totalPnlSol = closed.reduce((sum, position) => sum + Number(position.pnl_sol || 0), 0);
  const byRoute = new Map();
  for (const position of closed) {
    const candidate = positionSnapshotCandidate(position);
    const route = candidate.signals?.route || candidate.signals?.label || 'unknown';
    const row = byRoute.get(route) || { route, count: 0, wins: 0, losses: 0, pnlPercent: 0, pnlSol: 0 };
    row.count += 1;
    row.wins += Number(position.pnl_percent || 0) > 0 ? 1 : 0;
    row.losses += Number(position.pnl_percent || 0) < 0 ? 1 : 0;
    row.pnlPercent += Number(position.pnl_percent || 0);
    row.pnlSol += Number(position.pnl_sol || 0);
    byRoute.set(route, row);
  }
  const batches = db.prepare(`
    SELECT verdict, COUNT(*) AS count, AVG(confidence) AS avg_confidence
    FROM llm_batches
    WHERE created_at_ms >= ?
    GROUP BY verdict
  `).all(cutoff);
  const actions = db.prepare(`
    SELECT action, COUNT(*) AS count
    FROM decision_logs
    WHERE at_ms >= ?
    GROUP BY action
    ORDER BY count DESC
  `).all(cutoff);
  const best = [...closed].sort((a, b) => Number(b.pnl_percent || 0) - Number(a.pnl_percent || 0)).slice(0, 5).map(position => ({
    mint: position.mint,
    symbol: position.symbol,
    pnlPercent: Number(position.pnl_percent || 0),
    exitReason: position.exit_reason,
    entryMcap: position.entry_mcap,
    exitMcap: position.exit_mcap,
    route: positionSnapshotCandidate(position).signals?.route || 'unknown',
  }));
  const worst = [...closed].sort((a, b) => Number(a.pnl_percent || 0) - Number(b.pnl_percent || 0)).slice(0, 5).map(position => ({
    mint: position.mint,
    symbol: position.symbol,
    pnlPercent: Number(position.pnl_percent || 0),
    exitReason: position.exit_reason,
    entryMcap: position.entry_mcap,
    exitMcap: position.exit_mcap,
    route: positionSnapshotCandidate(position).signals?.route || 'unknown',
  }));
  return {
    windowMs,
    fromMs: cutoff,
    toMs: now(),
    positions: {
      opened: positions.length,
      closed: closed.length,
      open: positions.length - closed.length,
      wins: winners.length,
      losses: losers.length,
      winRate: closed.length ? winners.length / closed.length * 100 : null,
      totalPnlPercent,
      avgPnlPercent: closed.length ? totalPnlPercent / closed.length : null,
      totalPnlSol,
      byRoute: [...byRoute.values()].map(row => ({
        ...row,
        winRate: row.count ? row.wins / row.count * 100 : null,
        avgPnlPercent: row.count ? row.pnlPercent / row.count : null,
      })).sort((a, b) => b.pnlPercent - a.pnlPercent),
      best,
      worst,
    },
    llm: { batches, actions },
  };
}

function fallbackLessons(summary) {
  const lessons = [];
  const bestRoute = summary.positions.byRoute?.[0];
  const worstRoute = [...(summary.positions.byRoute || [])].sort((a, b) => a.pnlPercent - b.pnlPercent)[0];
  if (bestRoute && bestRoute.count >= 2 && bestRoute.pnlPercent > 0) {
    lessons.push({
      lesson: `Prefer ${bestRoute.route} when other filters are clean; it led the window with ${fmtPct(bestRoute.avgPnlPercent)} avg PnL across ${bestRoute.count} closed dry-runs.`,
      evidence: bestRoute,
    });
  }
  if (worstRoute && worstRoute.count >= 2 && worstRoute.pnlPercent < 0) {
    lessons.push({
      lesson: `Be stricter on ${worstRoute.route}; it underperformed with ${fmtPct(worstRoute.avgPnlPercent)} avg PnL across ${worstRoute.count} closed dry-runs.`,
      evidence: worstRoute,
    });
  }
  const slCount = summary.positions.worst?.filter(row => row.exitReason === 'SL').length || 0;
  if (slCount >= 2) {
    lessons.push({
      lesson: `Recent worst exits clustered around SL; require stronger fresh pre-entry mcap/liquidity confirmation before accepting late entries.`,
      evidence: { slWorstCount: slCount, worst: summary.positions.worst },
    });
  }
  if (!lessons.length) {
    lessons.push({
      lesson: 'Not enough closed dry-run evidence yet; keep collecting decisions before changing filters aggressively.',
      evidence: { closed: summary.positions.closed },
    });
  }
  return lessons.slice(0, 6);
}

async function generateLessons(summary) {
  const fallback = fallbackLessons(summary);
  if (!ENABLE_LLM || !LLM_API_KEY) return { lessons: fallback, raw: { fallback: true } };
  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: [
            'You are Charon learning from dry-run trading evidence.',
            'Return strict JSON only.',
            'Do not invent trades or outcomes.',
            'Create compact operational lessons that can improve the next screening prompt.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'Analyze this dry-run window and produce up to 6 lessons for future candidate screening.',
            output_schema: {
              lessons: [{ lesson: 'short actionable rule', evidence: 'specific supporting data' }],
            },
            summary,
          }),
        },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    const parsed = strictJsonFromText(res.data?.choices?.[0]?.message?.content || '');
    const lessons = Array.isArray(parsed.lessons)
      ? parsed.lessons.map(item => ({
          lesson: String(item.lesson || '').slice(0, 500),
          evidence: item.evidence ?? {},
        })).filter(item => item.lesson)
      : [];
    return { lessons: lessons.length ? lessons.slice(0, 6) : fallback, raw: parsed };
  } catch (err) {
    console.log(`[learn] LLM failed: ${err.message}`);
    return { lessons: fallback, raw: { error: err.message, fallback: true } };
  }
}

function storeLearningRun(windowMs, summary, lessons, raw) {
  const result = db.prepare(`
    INSERT INTO learning_runs (created_at_ms, window_ms, summary_json, lessons_json, raw_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(now(), windowMs, json(summary), json(lessons), json(raw));
  const runId = Number(result.lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO learning_lessons (run_id, created_at_ms, status, lesson, evidence_json)
    VALUES (?, ?, 'active', ?, ?)
  `);
  for (const item of lessons) insert.run(runId, now(), item.lesson, json(item.evidence || {}));
  return runId;
}

function learningReportText(runId, summary, lessons) {
  return [
    '🧠 <b>Charon Learning</b>',
    '',
    `Run: <b>#${runId}</b> · Window: <b>${formatWindow(summary.windowMs)}</b>`,
    `Closed: ${summary.positions.closed}/${summary.positions.opened} · Win rate: ${fmtPct(summary.positions.winRate)}`,
    `Avg PnL: ${fmtPct(summary.positions.avgPnlPercent)} · Total: ${fmtSol(summary.positions.totalPnlSol)} SOL`,
    summary.positions.byRoute?.length ? `Best route: <b>${escapeHtml(summary.positions.byRoute[0].route)}</b> avg ${fmtPct(summary.positions.byRoute[0].avgPnlPercent)} (${summary.positions.byRoute[0].count})` : null,
    '',
    '<b>Lessons</b>',
    ...lessons.map((item, index) => `${index + 1}. ${escapeHtml(item.lesson)}`),
  ].filter(Boolean).join('\n');
}

async function runLearning(chatId, windowArg = '12h') {
  const windowMs = parseWindowMs(windowArg);
  await bot.sendMessage(chatId, `Learning from the last ${formatWindow(windowMs)}...`);
  const summary = summarizeLearningWindow(windowMs);
  const { lessons, raw } = await generateLessons(summary);
  const runId = storeLearningRun(windowMs, summary, lessons, raw);
  return bot.sendMessage(chatId, learningReportText(runId, summary, lessons), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

async function sendLessons(chatId) {
  const rows = db.prepare(`
    SELECT id, created_at_ms, lesson
    FROM learning_lessons
    WHERE status = 'active'
    ORDER BY id DESC
    LIMIT 10
  `).all();
  const text = rows.length
    ? rows.map((row, index) => `${index + 1}. ${escapeHtml(row.lesson)}`).join('\n')
    : 'No active lessons yet. Run /learn 12h after some dry-run exits.';
  return bot.sendMessage(chatId, `🧠 <b>Active Lessons</b>\n\n${text}`, { parse_mode: 'HTML' });
}

function parseSetFilter(text) {
  const parts = text.trim().split(/\s+/);
  return { key: parts[1], value: parts[2] };
}

async function handleMessage(msg) {
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  if (await consumeNumericFilterInput(chatId, text)) return;
  if (!text.startsWith('/')) return;
  if (text.startsWith('/menu')) return sendMenu(chatId);
  if (text.startsWith('/positions')) return sendPositions(chatId);
  if (text.startsWith('/filters')) return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML' });
  if (text.startsWith('/pnl')) return sendPnl(chatId);
  if (text.startsWith('/learn')) {
    const windowArg = text.split(/\s+/)[1] || '12h';
    return runLearning(chatId, windowArg);
  }
  if (text.startsWith('/lessons')) return sendLessons(chatId);
  if (text.startsWith('/candidate')) {
    const mint = text.split(/\s+/)[1];
    if (!mint) return bot.sendMessage(chatId, 'Usage: /candidate <mint>');
    const row = latestCandidateByMint(mint);
    if (!row) return bot.sendMessage(chatId, 'Candidate not found.');
    return sendCandidate(chatId, row.id);
  }
  if (text.startsWith('/walletadd')) {
    const [, label, address] = text.split(/\s+/);
    if (!label || !address) return bot.sendMessage(chatId, 'Usage: /walletadd <label> <address>');
    db.prepare(`
      INSERT INTO saved_wallets (label, address, created_at_ms) VALUES (?, ?, ?)
      ON CONFLICT(label) DO UPDATE SET address = excluded.address
    `).run(label, address, now());
    return bot.sendMessage(chatId, `Saved wallet ${label}.`);
  }
  if (text.startsWith('/walletremove')) {
    const label = text.split(/\s+/)[1];
    if (!label) return bot.sendMessage(chatId, 'Usage: /walletremove <label>');
    db.prepare('DELETE FROM saved_wallets WHERE label = ?').run(label);
    return bot.sendMessage(chatId, `Removed ${label}.`);
  }
  if (text.startsWith('/wallets')) return handleCallback({ id: 'manual', data: 'menu:wallets', message: { chat: { id: chatId } } });
  if (text.startsWith('/setfilter')) {
    const { key, value } = parseSetFilter(text);
    const valid = new Set([
      'min_fee_claim_sol',
      'min_mcap_usd',
      'max_mcap_usd',
      'min_gmgn_total_fee_sol',
      'min_graduated_volume_usd',
      'max_top20_holder_percent',
      'min_saved_wallet_holders',
      'trending_enabled',
      'trending_source',
      'trending_allow_degen',
      'trending_interval',
      'trending_limit',
      'trending_order_by',
      'trending_min_volume_usd',
      'trending_min_swaps',
      'trending_max_rug_ratio',
      'trending_max_bundler_rate',
      'trading_mode',
      'llm_min_confidence',
      'llm_candidate_pick_count',
      'llm_candidate_max_age_ms',
      'max_open_positions',
      'dry_run_buy_sol',
      'default_tp_percent',
      'default_sl_percent',
      'default_trailing_enabled',
      'default_trailing_percent',
    ]);
    if (!valid.has(key) || value == null) {
      return bot.sendMessage(chatId, `Usage: /setfilter &lt;name&gt; &lt;value&gt;\n\n${filtersText()}`, { parse_mode: 'HTML' });
    }
    setSetting(key, value === 'off' ? '0' : value);
    return bot.sendMessage(chatId, filtersText(), { parse_mode: 'HTML' });
  }
}

function setupTelegram() {
  bot.setMyCommands([
    { command: 'menu', description: 'Open Charon menu' },
    { command: 'positions', description: 'Show dry-run positions' },
    { command: 'candidate', description: 'Show candidate by mint' },
    { command: 'filters', description: 'Show filters' },
    { command: 'pnl', description: 'Show saved-wallet PnL' },
    { command: 'learn', description: 'Run manual learning report' },
    { command: 'lessons', description: 'Show active screening lessons' },
    { command: 'setfilter', description: 'Set a filter value' },
    { command: 'walletadd', description: 'Save wallet for exposure/PnL' },
    { command: 'walletremove', description: 'Remove saved wallet' },
    { command: 'wallets', description: 'List saved wallets' },
  ]).catch(err => console.log(`[telegram] commands ${err.message}`));

  bot.on('callback_query', query => handleCallback(query).catch(err => console.log(`[callback] ${err.message}`)));
  bot.on('message', msg => handleMessage(msg).catch(err => console.log(`[message] ${err.message}`)));
  bot.on('polling_error', err => console.log(`[telegram] polling ${err.message}`));
}

export async function startCharon() {
  initDb();
  initLiveExecution();
  setupTelegram();
  await fetchGraduatedCoins().catch(error => console.log(`[graduated] initial fetch failed: ${error.message}`));
  await fetchGmgnTrending().catch(error => console.log(`[trending] initial fetch failed: ${error.message}`));
  setInterval(() => fetchGraduatedCoins().catch(error => console.log(`[graduated] ${error.message}`)), GRADUATED_POLL_MS);
  setInterval(() => fetchGmgnTrending().catch(error => console.log(`[trending] ${error.message}`)), TRENDING_POLL_MS);
  setInterval(() => monitorPositions().catch(error => console.log(`[monitor] ${error.message}`)), POSITION_CHECK_MS);
  startWebsocket();
  console.log(`[bot] ${APP_NAME} started`);
}
