import { db } from '../db/connection.js';
import { gmgnFetch } from '../enrichment/gmgn.js';
import { now, json } from '../utils.js';

const seenTx = new Set();

function tradeList(payload) {
  return payload?.data?.list
    || payload?.data?.data?.list
    || payload?.list
    || [];
}

function tradeMint(row) {
  return row?.base_address || row?.mint || row?.token_address || row?.baseToken?.address || null;
}

function tradeSide(row) {
  return String(row?.side || '').toLowerCase() === 'sell' ? 'sell' : 'buy';
}

function makerTags(row) {
  const tags = row?.maker_info?.tags || row?.makerInfo?.tags || [];
  return Array.isArray(tags) ? tags.map(String) : [];
}

function tradeTimestampMs(row) {
  const ts = Number(row?.timestamp || row?.block_timestamp || 0);
  if (!Number.isFinite(ts) || ts <= 0) return now();
  return ts > 10_000_000_000 ? ts : ts * 1000;
}

export function smartMoneyCluster(mint, windowMs = 5 * 60_000) {
  const since = now() - windowMs;
  const rows = db.prepare(`
    SELECT maker, side, amount_usd, quote_amount, at_ms, tags_json
    FROM smartmoney_trades
    WHERE mint = ? AND at_ms >= ?
    ORDER BY at_ms DESC
  `).all(mint, since);
  const buyers = new Set(rows.filter(row => row.side === 'buy').map(row => row.maker));
  const sellers = new Set(rows.filter(row => row.side === 'sell').map(row => row.maker));
  const buyUsd = rows.filter(row => row.side === 'buy').reduce((sum, row) => sum + Number(row.amount_usd || 0), 0);
  const sellUsd = rows.filter(row => row.side === 'sell').reduce((sum, row) => sum + Number(row.amount_usd || 0), 0);
  return {
    windowMs,
    trades: rows.length,
    uniqueBuyers: buyers.size,
    uniqueSellers: sellers.size,
    buyUsd,
    sellUsd,
    netUsd: buyUsd - sellUsd,
    buyPressure: buyUsd + sellUsd > 0 ? buyUsd / (buyUsd + sellUsd) : null,
  };
}

export async function pollGmgnSmartMoney({ limit = 50 } = {}) {
  const payload = await gmgnFetch('/v1/user/smartmoney', {
    params: { chain: 'sol', limit },
  });
  const rows = tradeList(payload);
  let inserted = 0;
  const insertTrade = db.prepare(`
    INSERT OR IGNORE INTO smartmoney_trades (
      tx_hash, mint, maker, side, at_ms, amount_usd, quote_amount, price_usd,
      is_open_or_close, tags_json, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSignal = db.prepare(`
    INSERT INTO signal_events (mint, kind, at_ms, source, payload_json)
    VALUES (?, 'smartmoney', ?, 'gmgn_smartmoney', ?)
  `);

  const tx = db.transaction((items) => {
    for (const row of items) {
      const txHash = row?.transaction_hash || row?.hash || row?.tx_hash;
      const mint = tradeMint(row);
      const maker = row?.maker;
      if (!txHash || !mint || !maker) continue;
      const atMs = tradeTimestampMs(row);
      const tags = makerTags(row);
      const side = tradeSide(row);
      const result = insertTrade.run(
        txHash,
        mint,
        maker,
        side,
        atMs,
        Number(row?.amount_usd || 0),
        Number(row?.quote_amount || 0),
        Number(row?.price_usd || row?.price || 0),
        Number(row?.is_open_or_close ?? 0),
        json(tags),
        json(row),
      );
      if (result.changes > 0) {
        inserted += 1;
        insertSignal.run(mint, atMs, json({ ...row, smartMoneyCluster: smartMoneyCluster(mint) }));
      }
      seenTx.add(txHash);
    }
  });

  tx(rows);
  console.log(`[smartmoney] loaded ${rows.length}, inserted ${inserted}`);
  return { loaded: rows.length, inserted };
}
