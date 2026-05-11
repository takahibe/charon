import WebSocket from 'ws';
import { Connection } from '@solana/web3.js';
import { METEORA_DBC_PROGRAM, SOLANA_WS_URL, SOLANA_RPC_URL, WSOL_MINT } from '../config.js';
import { now, pruneSeen } from '../utils.js';

// Instruction names emitted in logs when a new Meteora DBC pool is created
const INIT_INSTRUCTIONS = [
  'Instruction: InitializeVirtualPoolWithSplToken',
  'Instruction: InitializeVirtualPoolWithToken2022',
];

const seenLaunches = new Map();
let candidateHandler = null;
const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

export function setMeteoraCandidateHandler(fn) {
  candidateHandler = fn;
}

// Fetch the transaction and extract the new token mint from token balances.
// The pool creation transaction touches two token vaults: one for WSOL (quote)
// and one for the new token (base). We return the non-WSOL mint.
async function extractMintFromTransaction(signature) {
  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    });
    if (!tx) return null;

    const postMints = (tx.meta?.postTokenBalances || []).map(b => b.mint);
    const newMint = postMints.find(m => m !== WSOL_MINT);
    return newMint || null;
  } catch (error) {
    console.log(`[meteora_dbc] tx fetch failed (${signature.slice(0, 8)}): ${error.message}`);
    return null;
  }
}

async function processLog(logInfo) {
  const { signature, logs, err } = logInfo;
  if (err || !logs) return;

  const isNewPool = logs.some(line => INIT_INSTRUCTIONS.some(instr => line.includes(instr)));
  if (!isNewPool) return;

  pruneSeen(seenLaunches, 10 * 60 * 1000);
  if (seenLaunches.has(signature)) return;
  seenLaunches.set(signature, now());

  const mint = await extractMintFromTransaction(signature);
  if (!mint) {
    console.log(`[meteora_dbc] could not extract mint from ${signature.slice(0, 8)}`);
    return;
  }

  console.log(`[meteora_dbc] new launch detected: ${mint.slice(0, 8)}... (tx: ${signature.slice(0, 8)})`);

  if (candidateHandler) {
    await candidateHandler({
      mint,
      signature,
      route: 'meteora_dbc',
    });
  }
}

export function startMeteoraDbcWebsocket() {
  let ws;
  let pingTimer;

  function connect() {
    ws = new WebSocket(SOLANA_WS_URL);

    ws.on('open', () => {
      console.log('[meteora_dbc] connected, watching for new launches');
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'logsSubscribe',
        params: [{ mentions: [METEORA_DBC_PROGRAM] }, { commitment: 'confirmed' }],
      }));
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 30_000);
    });

    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const value = msg.params?.result?.value;
      if (msg.method === 'logsNotification' && value) {
        processLog(value).catch(e => console.log(`[meteora_dbc] process failed: ${e.message}`));
      }
    });

    ws.on('close', () => {
      clearInterval(pingTimer);
      console.log('[meteora_dbc] disconnected, reconnecting in 5s');
      setTimeout(connect, 5000);
    });

    ws.on('error', error => console.log(`[meteora_dbc] ws error: ${error.message}`));
  }

  connect();
}
