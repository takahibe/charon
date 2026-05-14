import dotenv from 'dotenv';

dotenv.config({ override: true });

function envValue(key, fallback = '') {
  const raw = process.env[key];
  if (raw == null) return fallback;
  return String(raw).replace(/\s+#.*$/, '').trim();
}

function envFlag(key, fallback = false) {
  const value = envValue(key, fallback ? 'true' : 'false').toLowerCase();
  return !['false', '0', 'no', 'off'].includes(value);
}

function envNumber(key, fallback) {
  const parsed = Number(envValue(key, String(fallback)));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const APP_NAME = 'Charon';
export const DB_PATH = envValue('DB_PATH', './charon.sqlite');
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const DISC_DIST_FEES = Buffer.from('a537817004b3ca28', 'hex');
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_MINT = 'So11111111111111111111111111111111111111111';

export const TELEGRAM_BOT_TOKEN = envValue('TELEGRAM_BOT_TOKEN');
export const TELEGRAM_CHAT_ID = envValue('TELEGRAM_CHAT_ID');
export const TELEGRAM_TOPIC_ID = envValue('TELEGRAM_TOPIC_ID');
export const HELIUS_API_KEY = envValue('HELIUS_API_KEY');
export const GMGN_API_KEY = envValue('GMGN_API_KEY');
export const GMGN_ENABLED = envFlag('GMGN_ENABLED', true);
export const JUPITER_API_KEY = envValue('JUPITER_API_KEY');
export const SOLANA_PRIVATE_KEY = envValue('SOLANA_PRIVATE_KEY', envValue('PRIVATE_KEY'));
export const SOLANA_RPC_URL = envValue('SOLANA_RPC_URL') || `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
export const SOLANA_WS_URL = envValue('SOLANA_WS_URL') || `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
export const JUPITER_SWAP_BASE_URL = envValue('JUPITER_SWAP_BASE_URL', 'https://api.jup.ag/swap/v2');
export const JUPITER_SLIPPAGE_BPS = envNumber('JUPITER_SLIPPAGE_BPS', 300);
export const LIVE_MIN_SOL_RESERVE_LAMPORTS = Math.floor(envNumber('LIVE_MIN_SOL_RESERVE', 0.02) * 1_000_000_000);
export const LLM_BASE_URL = envValue('LLM_BASE_URL', 'https://api.minimax.io/v1');
export const LLM_API_KEY = envValue('LLM_API_KEY');
export const LLM_MODEL = envValue('LLM_MODEL', 'MiniMax-M2.7');

export const GRADUATED_POLL_MS = envNumber('GRADUATED_POLL_MS', 30_000);
export const GRADUATED_LOOKBACK_MS = envNumber('GRADUATED_LOOKBACK_MS', 2 * 60 * 60 * 1000);
export const TRENDING_POLL_MS = envNumber('TRENDING_POLL_MS', 60_000);
export const TRENDING_LOOKBACK_MS = envNumber('TRENDING_LOOKBACK_MS', 10 * 60 * 1000);
export const GMGN_CACHE_TTL_MS = envNumber('GMGN_CACHE_TTL_MS', 5 * 60 * 1000);
export const POSITION_CHECK_MS = envNumber('POSITION_CHECK_MS', 10_000);
export const PERIODIC_SUMMARY_MS = envNumber('PERIODIC_SUMMARY_MS', 4 * 60 * 60 * 1000);
export const LLM_TIMEOUT_MS = envNumber('LLM_TIMEOUT_MS', 60_000);
export const ENABLE_LLM = envFlag('ENABLE_LLM', true);
export const SIGNAL_SERVER_URL = envValue('SIGNAL_SERVER_URL', 'http://localhost:3456');
export const SIGNAL_SERVER_KEY = envValue('SIGNAL_SERVER_KEY');
export const SIGNAL_POLL_MS = envNumber('SIGNAL_POLL_MS', 30_000);

export const METEORA_DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
// LAUNCHPAD: 'pump' = Pump.fun only, 'meteora_dbc' = Meteora DBC only, 'both' = both sources
export const LAUNCHPAD = envValue('LAUNCHPAD', 'pump').toLowerCase();
export const ENABLE_METEORA_DBC = LAUNCHPAD === 'meteora_dbc' || LAUNCHPAD === 'both';
export const METEORA_DBC_POLL_MS = envNumber('METEORA_DBC_POLL_MS', 10_000);

export const JSON_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

export function validateConfig() {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required.');
  if (!TELEGRAM_CHAT_ID) throw new Error('TELEGRAM_CHAT_ID is required.');
  if (!HELIUS_API_KEY && (!envValue('SOLANA_RPC_URL') || !envValue('SOLANA_WS_URL'))) {
    throw new Error('HELIUS_API_KEY is required unless SOLANA_RPC_URL and SOLANA_WS_URL are set.');
  }
  if (GMGN_ENABLED && !GMGN_API_KEY) throw new Error('GMGN_API_KEY is required unless GMGN_ENABLED=false.');
}
