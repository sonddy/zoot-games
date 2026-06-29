require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const {
  Keypair, Connection, PublicKey, LAMPORTS_PER_SOL,
  Transaction, SystemProgram, sendAndConfirmTransaction,
} = require('@solana/web3.js');
const {
  getMint,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const persistence = require('./persistence');
const marketAgent = require('./marketAgent');
const tv = require('./tv');
const DominoGame = require('./games/domino');
const TicTacToeGame = require('./games/tictactoe');
const MancalaGame = require('./games/mancala');
const CheckersGame = require('./games/checkers');
const ChessGame = require('./games/chess');
const MorpionGame = require('./games/morpion');
const WarGame = require('./games/war');
const SpeedGame = require('./games/speed');
const PokerGame = require('./games/poker');
const ReversiGame = require('./games/reversi');
const Connect4Game = require('./games/connect4');
const BattleshipGame = require('./games/battleship');
const BackgammonGame = require('./games/backgammon');
const RPSGame = require('./games/rps');
const CoinFlipGame = require('./games/coinflip');
const DiceDuelGame = require('./games/diceduel');
const HiLoGame = require('./games/hilo');
const DotsBoxesGame = require('./games/dotsboxes');
const NimGame = require('./games/nim');
const HexGame = require('./games/hex');
const ReactionGame = require('./games/reaction');
const MemoryGame = require('./games/memory');
const MathDuelGame = require('./games/mathduel');
const houseBot = require('./houseBot');
const houseAbuse = require('./houseAbuse');

const SOLANA_RPC = process.env.SOLANA_RPC || 'https://solana-rpc.publicnode.com';
const solanaConnection = new Connection(SOLANA_RPC, 'confirmed');

// SECURITY: the escrow key is the most sensitive secret in the system.
//  - We FAIL CLOSED: if ESCROW_PRIVATE_KEY isn't provided we refuse to start,
//    rather than silently generating a throwaway hot wallet.
//  - We NEVER log the private key (or anything derived from secretKey). The
//    previous code printed the generated key in plaintext to stdout, which on a
//    hosted log stream is equivalent to publishing it. That is believed to be
//    how the original escrow key leaked and got swept by an attacker.
let escrowKeypair;
if (!process.env.ESCROW_PRIVATE_KEY) {
  console.error('FATAL: ESCROW_PRIVATE_KEY is not set. Refusing to start without a configured escrow wallet.');
  console.error('Generate a key on a clean machine and set it as the ESCROW_PRIVATE_KEY env var (base64-encoded secret key).');
  process.exit(1);
}
try {
  escrowKeypair = Keypair.fromSecretKey(Buffer.from(process.env.ESCROW_PRIVATE_KEY, 'base64'));
} catch (e) {
  console.error('FATAL: ESCROW_PRIVATE_KEY could not be parsed (expected base64-encoded secret key). Refusing to start.');
  process.exit(1);
}
const ESCROW_ADDRESS = escrowKeypair.publicKey.toBase58();

// SECURITY: hard denylist of escrow wallets that are known-compromised. If the
// configured key ever derives to one of these, refuse to start — this makes it
// impossible to accidentally run the games on a drained/leaked wallet again.
const BLOCKED_ESCROW_ADDRESSES = new Set(
  (process.env.BLOCKED_ESCROW_ADDRESSES || '7aKmNNy3cbNA4DNEqAyLTwqKqKFLnJ7DntnfozEX945Q')
    .split(',').map(s => s.trim()).filter(Boolean)
);
if (BLOCKED_ESCROW_ADDRESSES.has(ESCROW_ADDRESS)) {
  console.error('FATAL: ESCROW_PRIVATE_KEY derives to a known-compromised wallet (' + ESCROW_ADDRESS + ').');
  console.error('This wallet was drained and must never be used again. Set ESCROW_PRIVATE_KEY to a freshly generated key and restart.');
  process.exit(1);
}

console.log('Escrow wallet:', ESCROW_ADDRESS); // public address only — never the secret

const ZOOT_MINT_ADDRESS = process.env.ZOOT_MINT || '3max6YL5yL6nrLHN3iHZWqfH1ufoSWFXs6RA4VjLhAtd';
const ZOOT_MINT = new PublicKey(ZOOT_MINT_ADDRESS);
let zootDecimals = 9;
let zootEscrowAta = null;

async function initZootToken() {
  try {
    const mintInfo = await getMint(solanaConnection, ZOOT_MINT);
    zootDecimals = mintInfo.decimals;
    zootEscrowAta = await getAssociatedTokenAddress(ZOOT_MINT, escrowKeypair.publicKey);
    const info = await solanaConnection.getAccountInfo(zootEscrowAta);
    if (!info) {
      console.log('ZOOT escrow ATA does not exist, creating...');
      try {
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            escrowKeypair.publicKey,
            zootEscrowAta,
            escrowKeypair.publicKey,
            ZOOT_MINT
          )
        );
        await sendAndConfirmTransaction(solanaConnection, tx, [escrowKeypair]);
        console.log('ZOOT escrow ATA created:', zootEscrowAta.toBase58());
      } catch (e) {
        console.error('Failed to create ZOOT escrow ATA (escrow may need SOL for rent):', e.message);
      }
    }
    console.log('ZOOT token ready — mint:', ZOOT_MINT_ADDRESS, '| decimals:', zootDecimals, '| escrow ATA:', zootEscrowAta ? zootEscrowAta.toBase58() : 'n/a');
  } catch (e) {
    console.error('ZOOT init warning:', e.message);
  }
}
initZootToken();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/escrow', (req, res) => {
  res.json({ escrowAddress: ESCROW_ADDRESS });
});

// Public: lets the client know whether the House is open or under maintenance.
app.get('/api/house/status', (req, res) => {
  res.json({ maintenance: houseMaintenance, message: houseMaintenance ? houseMaintenanceMsg : '' });
});

// Admin: flip House maintenance on/off at runtime (no redeploy). Requires
// ADMIN_TOKEN to be set in the environment and supplied in the request.
//   curl -X POST .../api/house/maintenance -H 'content-type: application/json' \
//        -d '{"token":"<ADMIN_TOKEN>","on":true,"message":"optional custom text"}'
app.post('/api/house/maintenance', (req, res) => {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return res.status(403).json({ error: 'Admin toggle disabled: set ADMIN_TOKEN to use this.' });
  const provided = (req.body && req.body.token) || req.query.token;
  if (provided !== adminToken) return res.status(401).json({ error: 'Unauthorized' });
  houseMaintenance = !!(req.body && req.body.on);
  if (req.body && typeof req.body.message === 'string' && req.body.message.trim()) {
    houseMaintenanceMsg = req.body.message.trim();
  }
  console.log('[house] maintenance set to', houseMaintenance, 'via admin endpoint');
  res.json({ maintenance: houseMaintenance, message: houseMaintenanceMsg });
});

// ── Prediction Markets (admin-managed, P2P even-money) ──────────────────────
// Markets are created and resolved by an admin (or an automated agent calling
// these same endpoints). Players take YES/NO offers against each other; on
// resolution the winning side is paid 1.8x and the house takes a 10% rake.
function checkAdmin(req) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return { ok: false, code: 403, error: 'Admin API disabled: set ADMIN_TOKEN to use this.' };
  const provided = (req.body && req.body.token) || req.query.token || req.get('x-admin-token');
  if (provided !== adminToken) return { ok: false, code: 401, error: 'Unauthorized' };
  return { ok: true };
}

// Public: list markets with their open offers and volume stats.
app.get('/api/markets', (req, res) => {
  res.json(buildMarketsPayload());
});

// Shared market creation used by both the admin REST endpoint and the
// automated market agent. Throws on invalid input.
function createPredictionMarket(opts) {
  const o = opts || {};
  const question = String(o.question || '').trim();
  if (!question) throw new Error('question is required');
  const id = 'pm_' + uuidv4().slice(0, 8);
  const auto = o.auto || null;
  const market = {
    id,
    question,
    description: String(o.description || '').trim(),
    category: String(o.category || 'General').trim(),
    status: 'open',
    outcome: null,
    closesAt: o.closesAt ? Number(o.closesAt) : (auto && auto.resolveAt ? Number(auto.resolveAt) : null),
    resolvesAt: o.resolvesAt ? Number(o.resolvesAt) : (auto && auto.resolveAt ? Number(auto.resolveAt) : null),
    auto,
    createdAt: Date.now(),
    resolvedAt: null,
  };
  predictionMarkets.set(id, market);
  persistence.savePredictionMarket(id, market).catch(()=>{});
  console.log('[markets] created', id, auto ? '(auto:' + auto.provider + ')' : '', '-', question);
  broadcastPredictions();
  return market;
}

// Admin: create a market.
app.post('/api/markets', (req, res) => {
  const auth = checkAdmin(req); if (!auth.ok) return res.status(auth.code).json({ error: auth.error });
  try {
    const market = createPredictionMarket(req.body || {});
    res.json({ ok: true, market });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Admin: close betting on a market (existing matched bets remain until resolve).
app.post('/api/markets/:id/close', (req, res) => {
  const auth = checkAdmin(req); if (!auth.ok) return res.status(auth.code).json({ error: auth.error });
  const m = predictionMarkets.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Market not found' });
  if (m.status === 'resolved') return res.status(400).json({ error: 'Market already resolved' });
  m.status = 'closed';
  persistence.savePredictionMarket(m.id, m).catch(()=>{});
  broadcastPredictions();
  res.json({ ok: true, market: m });
});

// Admin: reopen a closed (not resolved) market for betting.
app.post('/api/markets/:id/open', (req, res) => {
  const auth = checkAdmin(req); if (!auth.ok) return res.status(auth.code).json({ error: auth.error });
  const m = predictionMarkets.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Market not found' });
  if (m.status === 'resolved') return res.status(400).json({ error: 'Market already resolved' });
  m.status = 'open';
  persistence.savePredictionMarket(m.id, m).catch(()=>{});
  broadcastPredictions();
  res.json({ ok: true, market: m });
});

// Admin: resolve a market. outcome ∈ YES | NO | CANCEL. Triggers settlement.
app.post('/api/markets/:id/resolve', async (req, res) => {
  const auth = checkAdmin(req); if (!auth.ok) return res.status(auth.code).json({ error: auth.error });
  const m = predictionMarkets.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Market not found' });
  if (m.status === 'resolved') return res.status(400).json({ error: 'Market already resolved' });
  const outcome = String((req.body && req.body.outcome) || '').toUpperCase();
  if (!['YES', 'NO', 'CANCEL'].includes(outcome)) {
    return res.status(400).json({ error: "outcome must be 'YES', 'NO', or 'CANCEL'" });
  }
  try {
    const summary = await settlePredictionMarket(m, outcome);
    res.json({ ok: true, market: m, settlement: summary });
  } catch (e) {
    console.error('[markets] resolve error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const APK_PATH = path.join(__dirname, '..', 'public', 'downloads', 'zoot-games.apk');
app.get('/api/app/info', (req, res) => {
  try {
    const fs = require('fs');
    if (!fs.existsSync(APK_PATH)) return res.json({ available: false });
    const stat = fs.statSync(APK_PATH);
    res.json({
      available: true,
      size: stat.size,
      sizeMb: (stat.size / (1024 * 1024)).toFixed(1),
      updated: stat.mtime.toISOString(),
      url: '/download',
    });
  } catch (e) {
    res.json({ available: false });
  }
});

app.get('/download', (req, res) => {
  const fs = require('fs');
  if (!fs.existsSync(APK_PATH)) {
    return res.status(404).type('html').send(`
      <!doctype html><html><head><meta charset="utf-8"><title>Zoot Games — APK</title>
      <style>body{background:#0b0f1c;color:#e6e9f2;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:2rem;}
      h1{color:#ffc107;} a{color:#ffc107;}</style></head>
      <body><div><h1>Android App Coming Soon</h1>
      <p>The Zoot Games APK isn't published yet. Check back soon, or play in your mobile browser at <a href="/">zootgames.org</a>.</p></div></body></html>`);
  }
  res.setHeader('Content-Disposition', 'attachment; filename="zoot-games.apk"');
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(APK_PATH);
});

app.get('/api/sports/:sport/:league/scoreboard', async (req, res) => {
  const { sport, league } = req.params;
  const allowed = ['soccer','football','basketball','baseball','hockey','mma'];
  if (!allowed.includes(sport)) return res.status(400).json({ error: 'Invalid sport' });

  const days = Math.min(60, Math.max(1, parseInt(req.query.days, 10) || 30));
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const start = new Date();
  const end = new Date();
  end.setUTCDate(end.getUTCDate() + days);
  const dates = `${fmt(start)}-${fmt(end)}`;

  try {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?dates=${dates}&limit=200`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn('ESPN range fetch failed', sport, league, resp.status, '— falling back to today only');
      const today = fmt(new Date());
      const fallback = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?dates=${today}`);
      if (!fallback.ok) return res.status(fallback.status).json({ error: 'ESPN API error' });
      const data = await fallback.json();
      res.set('Cache-Control', 'public, max-age=15');
      return res.json(data);
    }
    const data = await resp.json();
    res.set('Cache-Control', 'public, max-age=15');
    res.json(data);
  } catch (err) {
    console.error('ESPN proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch from ESPN' });
  }
});

// ── Live TV (free IPTV channels, proxied for CORS) ──────────────────────────
app.get('/api/tv/channels', async (req, res) => {
  if (process.env.TV_DISABLE === '1') return res.status(404).json({ error: 'Live TV disabled' });
  try {
    const list = await tv.getChannelList({ sportOnly: req.query.sport === '1', includeDead: req.query.all === '1' });
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ count: list.length, channels: list });
  } catch (e) {
    console.error('[tv] channels error:', e.message);
    res.status(502).json({ error: 'Failed to load channels' });
  }
});

app.get('/api/tv/proxy', tv.proxyHandler);

const PANDASCORE_TOKEN = process.env.PANDASCORE_API_KEY || '';

app.get('/api/esports/running', async (req, res) => {
  try {
    const headers = PANDASCORE_TOKEN ? { 'Authorization': 'Bearer ' + PANDASCORE_TOKEN } : {};
    const url = 'https://api.pandascore.co/matches/running?per_page=50&sort=-scheduled_at';
    const resp = await fetch(url, { headers });
    if (!resp.ok) return res.status(resp.status).json({ error: 'PandaScore API error' });
    const data = await resp.json();
    res.set('Cache-Control', 'public, max-age=30');
    res.json(data);
  } catch (err) {
    console.error('PandaScore running error:', err.message);
    res.status(502).json({ error: 'Failed to fetch esports data' });
  }
});

app.get('/api/esports/upcoming', async (req, res) => {
  try {
    const headers = PANDASCORE_TOKEN ? { 'Authorization': 'Bearer ' + PANDASCORE_TOKEN } : {};
    const url = 'https://api.pandascore.co/matches/upcoming?per_page=50&sort=scheduled_at';
    const resp = await fetch(url, { headers });
    if (!resp.ok) return res.status(resp.status).json({ error: 'PandaScore API error' });
    const data = await resp.json();
    res.set('Cache-Control', 'public, max-age=60');
    res.json(data);
  } catch (err) {
    console.error('PandaScore upcoming error:', err.message);
    res.status(502).json({ error: 'Failed to fetch esports data' });
  }
});

const rooms = new Map();
const players = new Map();
const matchQueue = new Map();
const usedSignatures = new Set();
const sportsBets = new Map();
const predictionMarkets = new Map(); // marketId -> market
const predictionBets = new Map();    // betId -> bet (offer/matched/settled)
const chatBuckets = new Map();

const HOUSE_FEE = 0.10;
const HOUSE_WALLET = '2LK7yxZsy6YVCkFQ4PrL644ve1fgRj5FuDexj5JgS753';
const TEST_MODE = process.env.TEST_MODE === '1';

// ── House maintenance switch ──
// When on, the server refuses to start any new vs-house games and tells clients
// the house is down for maintenance (PvP play is unaffected). Seeded from env
// and toggleable at runtime via POST /api/house/maintenance (needs ADMIN_TOKEN).
let houseMaintenance = process.env.HOUSE_MAINTENANCE === '1';
let houseMaintenanceMsg = process.env.HOUSE_MAINTENANCE_MSG
  || 'The House is temporarily down for maintenance. You can still play against other players — please check back soon.';

// ── Outflow circuit breaker ──
// A rolling 24h cap on everything the SERVER pays out of the escrow. This is a
// defense-in-depth backstop against a payout/refund logic exploit. (Note: it
// CANNOT stop a stolen-key attacker, who signs transfers directly and never
// touches this code — that is what the key rotation + no-logging fix is for.)
// Caps are generous by default and overridable via env so legitimate refunds
// during recovery aren't blocked.
const OUTFLOW_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_OUTFLOW_24H = {
  SOL: parseFloat(process.env.MAX_OUTFLOW_SOL || '10'),
  ZOOT: parseFloat(process.env.MAX_OUTFLOW_ZOOT || '1000000'),
};
const outflowLog = []; // [{ t, currency, amount }]
function _outflow24h(currency) {
  const cutoff = Date.now() - OUTFLOW_WINDOW_MS;
  while (outflowLog.length && outflowLog[0].t < cutoff) outflowLog.shift();
  let sum = 0;
  for (const e of outflowLog) if (e.currency === currency) sum += e.amount;
  return sum;
}
// Reject deposits whose on-chain timestamp is older than this, so an attacker
// can't replay a stale (already-spent) deposit signature after a restart wipes
// the in-memory usedSignatures set.
const MAX_TX_AGE_MS = 15 * 60 * 1000;

// ── Withdrawal allowlist ──
// The escrow may ONLY pay addresses that have a real obligation in the system:
//   - the configured house-fee wallet,
//   - a wallet that entered a paid game / queue / sports bet (it deposited),
//   - a wallet we owe a persisted refund to (recovered on restart).
// Every legitimate payout target is registered via allowPayee() at the moment
// the obligation is created. A payout to anything else is almost certainly a
// bug or an injection, so we block it. This is the guard that ensures even a
// future payout-logic flaw can't redirect escrow funds to an attacker address.
const payeeAllowlist = new Set([HOUSE_WALLET]);
// Pre-seed extra trusted addresses (comma-separated) for manual recovery/ops,
// e.g. EXTRA_ALLOWED_PAYEES=addr1,addr2. The house fee wallet is always allowed.
for (const a of (process.env.EXTRA_ALLOWED_PAYEES || '').split(',').map(s => s.trim()).filter(Boolean)) {
  payeeAllowlist.add(a);
}
function allowPayee(addr) {
  if (addr) payeeAllowlist.add(addr);
}
function isAllowedPayee(addr) {
  return payeeAllowlist.has(addr);
}

async function sendSOL(toAddress, amount) {
  const destPubKey = new PublicKey(toAddress);
  const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: escrowKeypair.publicKey,
      toPubkey: destPubKey,
      lamports,
    })
  );
  const sig = await sendAndConfirmTransaction(solanaConnection, tx, [escrowKeypair]);
  console.log(`Sent ${amount} SOL to ${toAddress} — tx: ${sig}`);
  return sig;
}

async function sendZoot(toAddress, amount) {
  const destOwner = new PublicKey(toAddress);
  const destAta = await getAssociatedTokenAddress(ZOOT_MINT, destOwner);
  if (!zootEscrowAta) zootEscrowAta = await getAssociatedTokenAddress(ZOOT_MINT, escrowKeypair.publicKey);

  const ixs = [];
  const destInfo = await solanaConnection.getAccountInfo(destAta);
  if (!destInfo) {
    ixs.push(createAssociatedTokenAccountInstruction(
      escrowKeypair.publicKey, destAta, destOwner, ZOOT_MINT
    ));
  }
  const rawAmount = BigInt(Math.floor(amount * Math.pow(10, zootDecimals)));
  ixs.push(createTransferCheckedInstruction(
    zootEscrowAta, ZOOT_MINT, destAta, escrowKeypair.publicKey, rawAmount, zootDecimals
  ));
  const tx = new Transaction().add(...ixs);
  const sig = await sendAndConfirmTransaction(solanaConnection, tx, [escrowKeypair]);
  console.log(`Sent ${amount} ZOOT to ${toAddress} — tx: ${sig}`);
  return sig;
}

async function sendCurrency(currency, toAddress, amount) {
  const cur = currency === 'ZOOT' ? 'ZOOT' : 'SOL';

  // Allowlist guard: never pay an address that has no obligation in the system.
  if (!isAllowedPayee(toAddress)) {
    console.error(`[allowlist] BLOCKED payout of ${amount} ${cur} to non-allowlisted address ${toAddress}. This should never happen in normal play — investigate.`);
    throw new Error('Payout destination not allowlisted — blocked for safety');
  }

  // Circuit breaker: cap total escrow outflow per rolling 24h window.
  const cap = MAX_OUTFLOW_24H[cur];
  if (cap && (_outflow24h(cur) + amount) > cap) {
    console.error(`[circuit-breaker] ${cur} outflow cap tripped: attempted ${amount}, 24h total ${_outflow24h(cur)}, cap ${cap}. Blocking payout to ${toAddress}.`);
    throw new Error('Escrow outflow circuit breaker tripped — payout blocked for safety');
  }

  const sig = cur === 'ZOOT' ? await sendZoot(toAddress, amount) : await sendSOL(toAddress, amount);
  outflowLog.push({ t: Date.now(), currency: cur, amount });
  return sig;
}

/**
 * Refund a user with automatic persistence-backed retry.
 * Returns { ok: true, sig } if the payout went through immediately,
 * or { ok: false, queued: true } if it failed and was queued for retry.
 *
 * Notifies the user via socket if they're currently connected.
 */
async function refundUser({ walletAddress, currency, amount, reason, socketId }) {
  if (!walletAddress || !amount || amount <= 0) return { ok: false, error: 'Invalid refund' };
  const cur = currency === 'ZOOT' ? 'ZOOT' : 'SOL';

  if (TEST_MODE) {
    return { ok: true, sig: 'test_refund_' + Date.now() };
  }

  try {
    const sig = await sendCurrency(cur, walletAddress, amount);
    if (socketId) {
      const s = io.sockets.sockets.get(socketId);
      if (s) s.emit('balance_update', { refreshWallet: true, msg: (reason ? reason + ' — ' : '') + 'Refunded ' + amount + ' ' + cur + '!' });
    }
    return { ok: true, sig };
  } catch (e) {
    console.error('Refund failed, queuing for retry:', e.message);
    try {
      await enqueueRefund({
        walletAddress, currency: cur, amount,
        reason: reason || 'refund',
        retries: 0,
        lastError: e.message,
      });
    } catch (_) {}
    if (socketId) {
      const s = io.sockets.sockets.get(socketId);
      if (s) s.emit('balance_update', { refreshWallet: false, msg: 'Refund of ' + amount + ' ' + cur + ' queued — will retry automatically' });
    }
    return { ok: false, queued: true, error: e.message };
  }
}

const REFUND_RETRY_INTERVAL_MS = 60000;
const REFUND_MAX_RETRIES = 30;

// Best-effort count of refunds awaiting retry. Lets the retry loop skip the
// Firestore read entirely when there is nothing to do, so we don't burn the
// daily quota polling an empty collection every minute. Seeded at startup
// recovery and kept in sync as refunds are queued/cleared.
let knownPendingRefunds = 0;

async function enqueueRefund(refund) {
  const id = await persistence.addPendingRefund(refund);
  if (id) knownPendingRefunds++;
  return id;
}

async function processPendingRefunds() {
  if (!persistence.isEnabled()) return;
  if (knownPendingRefunds <= 0) return;
  let list = [];
  try { list = await persistence.listPendingRefunds(25); } catch (_) { return; }
  // The fetched list is the source of truth; resync our counter to it.
  knownPendingRefunds = list.length;
  for (const r of list) {
    if ((r.retries || 0) > REFUND_MAX_RETRIES) continue;
    try {
      // These are our own previously-recorded refund obligations, so the
      // recipient is trusted — allow it even after a restart cleared the set.
      allowPayee(r.walletAddress);
      await sendCurrency(r.currency || 'SOL', r.walletAddress, r.amount);
      await persistence.removePendingRefund(r.id);
      knownPendingRefunds = Math.max(0, knownPendingRefunds - 1);
      console.log('Pending refund cleared:', r.amount, r.currency, '→', r.walletAddress);
      for (const [sid, p] of players) {
        if (p.walletAddress === r.walletAddress) {
          const s = io.sockets.sockets.get(sid);
          if (s) s.emit('balance_update', { refreshWallet: true, msg: 'Pending refund of ' + r.amount + ' ' + (r.currency || 'SOL') + ' processed!' });
        }
      }
    } catch (e) {
      console.warn('Pending refund retry failed (retries=' + (r.retries || 0) + '):', e.message);
      try { await persistence.incrementRefundRetry(r.id, e.message); } catch (_) {}
    }
  }
}
setInterval(processPendingRefunds, REFUND_RETRY_INTERVAL_MS);

function _txTooOld(tx) {
  // tx.blockTime is unix seconds. Reject deposits older than MAX_TX_AGE_MS so a
  // stale signature can't be replayed after an in-memory set reset.
  if (typeof tx.blockTime === 'number') {
    if (Date.now() - tx.blockTime * 1000 > MAX_TX_AGE_MS) return true;
  }
  return false;
}

async function verifySolPayment(signature, expectedAmount) {
  const tx = await solanaConnection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || tx.meta.err) return { ok: false, error: 'Transaction not found or failed' };
  if (_txTooOld(tx)) return { ok: false, error: 'Payment transaction is too old — please make a fresh bet' };

  const accountKeys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys;
  const escrowIndex = accountKeys.findIndex(k => k.toBase58() === ESCROW_ADDRESS);
  if (escrowIndex === -1) return { ok: false, error: 'Transaction does not pay the escrow' };

  const received = (tx.meta.postBalances[escrowIndex] - tx.meta.preBalances[escrowIndex]) / LAMPORTS_PER_SOL;
  if (received < expectedAmount * 0.99) return { ok: false, error: 'Insufficient payment. Received ' + received.toFixed(6) + ' SOL' };

  return { ok: true, received };
}

async function verifyZootPayment(signature, expectedAmount) {
  const tx = await solanaConnection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || tx.meta.err) return { ok: false, error: 'Transaction not found or failed' };
  if (_txTooOld(tx)) return { ok: false, error: 'Payment transaction is too old — please make a fresh bet' };

  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];
  const mintStr = ZOOT_MINT_ADDRESS;

  const readAmount = (arr) => {
    for (const b of arr) {
      if (b.owner === ESCROW_ADDRESS && b.mint === mintStr) {
        return parseFloat(b.uiTokenAmount.uiAmountString || b.uiTokenAmount.uiAmount || '0');
      }
    }
    return 0;
  };
  const received = readAmount(post) - readAmount(pre);
  if (received < expectedAmount * 0.99) {
    return { ok: false, error: 'Insufficient $ZOOT payment. Received ' + received.toFixed(6) + ' ZOOT' };
  }
  return { ok: true, received };
}

async function verifyBetPayment(signature, expectedAmount, currency) {
  // Fast in-memory reject for replays seen this session.
  if (usedSignatures.has(signature)) return { ok: false, error: 'Transaction already used' };

  const useZoot = currency === 'ZOOT';
  const result = useZoot
    ? await verifyZootPayment(signature, expectedAmount)
    : await verifySolPayment(signature, expectedAmount);
  if (!result.ok) return result;

  // Atomically claim the signature so it can never be reused — including across
  // server restarts (in-memory set alone would forget after a restart).
  usedSignatures.add(signature);
  const consumed = await persistence.tryConsumeSignature(signature);
  if (consumed === false) {
    // Another request/instance already consumed it (or it was used before a
    // restart): reject as a replay.
    return { ok: false, error: 'Transaction already used' };
  }
  // consumed === true (claimed) or null (store unavailable → in-memory only).
  return result;
}

function createRoom(gameType, betAmount, player1Socket, currency) {
  const id = uuidv4().slice(0, 8);
  const room = { id, gameType, betAmount, currency: currency || 'SOL', players: [player1Socket], state: 'waiting', game: null, createdAt: Date.now(), turnTimer: null };
  rooms.set(id, room);
  return room;
}

async function persistActiveRoom(room) {
  if (!persistence.isEnabled() || room.state !== 'playing') return;
  const playerData = room.players.map(sid => {
    const p = players.get(sid);
    return p ? { socketId: sid, walletAddress: p.walletAddress, displayName: p.displayName } : null;
  }).filter(Boolean);
  await persistence.saveActiveRoom(room.id, {
    gameType: room.gameType,
    betAmount: room.betAmount,
    currency: room.currency || 'SOL',
    players: playerData,
    options: room.options || {},
    createdAt: room.createdAt,
  });
}

async function handleGameOver(room, result) {
  clearTurnTimer(room);
  if (room._houseTimer) { clearTimeout(room._houseTimer); room._houseTimer = null; }
  room.state = 'finished';
  persistence.removeActiveRoom(room.id).catch(()=>{});
  const winnerIdx = result.winner;
  const currency = room.currency || 'SOL';

  if (room.vsHouse) {
    committedHouseBets.delete(room.id);
    const playerSocketId = room.players[0];
    const player = players.get(playerSocketId);
    const agent = room.houseAgent;
    const houseLabel = agent ? agent.displayName : houseBot.HOUSE_DISPLAY_NAME;
    const houseWallet = agent ? agent.walletDisplay : houseBot.HOUSE_WALLET_DISPLAY;
    if (winnerIdx === 0) {
      const payout = room.betAmount * HOUSE_PAYOUT_MULTIPLIER;
      if (player && !TEST_MODE) {
        try {
          await sendCurrency('ZOOT', player.walletAddress, payout);
          const sock = io.sockets.sockets.get(playerSocketId);
          if (sock) sock.emit('balance_update', { refreshWallet: true, msg: 'You beat ' + houseLabel + ' for ' + payout.toFixed(2) + ' $ZOOT!' });
        } catch (e) {
          console.error('House payout error, queuing:', e.message);
          try { await enqueueRefund({ walletAddress: player.walletAddress, currency: 'ZOOT', amount: payout, reason: 'House game payout', retries: 0, lastError: e.message }); } catch (_) {}
        }
      }
      if (player) {
        houseBot.agents.recordResult(player.walletAddress, 'W', agent && agent.id);
        // Net change for the player on a win = payout - bet (they paid the bet
        // up front into escrow, now receive `payout`).
        houseAbuse.recordGameResult(player.walletAddress, 'W', payout - room.betAmount);
      }
      io.to(room.id).emit('game_over', {
        winner: player ? player.displayName : null,
        winnerWallet: player ? player.walletAddress : null,
        payout, currency: 'ZOOT', isDraw: false, resigned: !!result.resigned, vsHouse: true,
      });
    } else if (winnerIdx === 1) {
      if (player) {
        houseBot.agents.recordResult(player.walletAddress, 'L', agent && agent.id);
        houseAbuse.recordGameResult(player.walletAddress, 'L', -room.betAmount);
      }
      io.to(room.id).emit('game_over', {
        winner: houseLabel,
        winnerWallet: houseWallet,
        payout: 0, currency: 'ZOOT', isDraw: false, resigned: !!result.resigned, vsHouse: true,
      });
    } else {
      if (player && !TEST_MODE) {
        await refundUser({
          walletAddress: player.walletAddress,
          currency: 'ZOOT',
          amount: room.betAmount,
          reason: 'Draw vs House',
          socketId: playerSocketId,
        });
      }
      if (player) {
        houseBot.agents.recordResult(player.walletAddress, 'D', agent && agent.id);
        houseAbuse.recordGameResult(player.walletAddress, 'D', 0);
      }
      io.to(room.id).emit('game_over', { winner: null, winnerWallet: null, payout: 0, currency: 'ZOOT', isDraw: true, vsHouse: true });
    }
    setTimeout(() => cleanupRoom(room.id), 5000);
    return;
  }

  const pot = room.betAmount * 2;
  const houseCut = pot * HOUSE_FEE;
  const payout = pot - houseCut;

  if (winnerIdx !== null) {
    const winnerSocketId = room.players[winnerIdx];
    const winnerPlayer = players.get(winnerSocketId);
    if (winnerPlayer && !TEST_MODE) {
      try {
        await sendCurrency(currency, winnerPlayer.walletAddress, payout);
        const winSock = io.sockets.sockets.get(winnerSocketId);
        if (winSock) winSock.emit('balance_update', { refreshWallet: true, msg: 'You won ' + payout.toFixed(3) + ' ' + currency + '!' });
      } catch (e) {
        console.error('Payout error, queuing for retry:', e.message);
        try { await enqueueRefund({ walletAddress: winnerPlayer.walletAddress, currency, amount: payout, reason: 'Game payout', retries: 0, lastError: e.message }); } catch (_) {}
      }
      try {
        await sendCurrency(currency, HOUSE_WALLET, houseCut);
        console.log('House fee sent:', houseCut.toFixed(4), currency, 'to', HOUSE_WALLET);
      } catch (e) {
        console.error('House fee transfer error, queuing:', e.message);
        try { await enqueueRefund({ walletAddress: HOUSE_WALLET, currency, amount: houseCut, reason: 'House fee', retries: 0, lastError: e.message }); } catch (_) {}
      }
    }
    io.to(room.id).emit('game_over', {
      winner: winnerPlayer ? winnerPlayer.displayName : null,
      winnerWallet: winnerPlayer ? winnerPlayer.walletAddress : null,
      payout, currency, isDraw: false, resigned: !!result.resigned,
    });
  } else {
    if (!TEST_MODE) {
      for (const sid of room.players) {
        const p = players.get(sid);
        if (p) {
          await refundUser({
            walletAddress: p.walletAddress,
            currency,
            amount: room.betAmount,
            reason: 'Draw',
            socketId: sid,
          });
        }
      }
    }
    io.to(room.id).emit('game_over', { winner: null, winnerWallet: null, payout: 0, currency, isDraw: true });
  }
  setTimeout(() => cleanupRoom(room.id), 5000);
}

const TIMER_DELAYS = { domino: 25500, mancala: 30500, checkers: 45500, chess: 120500, morpion: 45500, war: 25500, speed: 30500, poker: 45500, reversi: 45500, connect4: 30500, battleship: 40500, backgammon: 45500, rps: 15500, coinflip: 15500, diceduel: 15500, hilo: 25500, dotsboxes: 30500, nim: 30500, hex: 45500, reaction: 25500, memory: 30500, mathduel: 25500 };

function startTurnTimer(room) {
  clearTurnTimer(room);
  if (!room.game || room.game.gameOver) return;
  if (room.game.roundOver) return;
  const delay = TIMER_DELAYS[room.gameType];
  if (!delay) return;

  room.turnTimer = setTimeout(() => {
    if (!room.game || room.game.gameOver || room.state !== 'playing') return;
    if (room.game.roundOver) return;
    const cp = room.game.currentPlayer;
    const result = room.game.autoPlayForTimeout(cp);
    if (!result) return;
    emitGameState(room);

    if (result.gameOver) {
      handleGameOver(room, result);
    } else {
      startTurnTimer(room);
    }
  }, delay);
}

function clearTurnTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
}

io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  socket.on('register', async ({ walletAddress, displayName }) => {
    if (!walletAddress || walletAddress.length < 2) return socket.emit('error_msg', { msg: 'Invalid wallet address' });
    if (!TEST_MODE) {
      try { new PublicKey(walletAddress); } catch (_) { return socket.emit('error_msg', { msg: 'Invalid Solana address' }); }
    }

    players.set(socket.id, { walletAddress, displayName: displayName || walletAddress.slice(0, 6), roomId: null });

    socket.emit('registered', {
      success: true,
      walletAddress,
      displayName: displayName || walletAddress.slice(0, 6),
      escrowAddress: ESCROW_ADDRESS,
      testMode: TEST_MODE,
      zootMint: ZOOT_MINT_ADDRESS,
      zootDecimals: zootDecimals,
      zootEscrowAta: zootEscrowAta ? zootEscrowAta.toBase58() : null,
    });
    broadcastLobby();
  });

  socket.on('find_match', async ({ gameType, betAmount, gridSize, txSignature, currency }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });

    const cur = currency === 'ZOOT' ? 'ZOOT' : 'SOL';
    const bet = parseFloat(betAmount) || 0;
    if (!TEST_MODE) {
      if (!bet || bet <= 0) return socket.emit('error_msg', { msg: 'Invalid bet amount' });
      if (!txSignature) return socket.emit('error_msg', { msg: 'No payment transaction provided' });
      const verification = await verifyBetPayment(txSignature, bet, cur);
      if (!verification.ok) return socket.emit('error_msg', { msg: verification.error });
    }

    const opts = {};
    if (gameType === 'tictactoe' && gridSize) opts.gridSize = gridSize;

    const queueKey = `${gameType}_${bet}_${cur}${gridSize ? '_' + gridSize : ''}`;
    if (matchQueue.has(queueKey)) {
      const waiting = matchQueue.get(queueKey);
      matchQueue.delete(queueKey);
      persistence.removeQueueEntry(queueKey).catch(()=>{});

      const room = createRoom(gameType, bet, waiting.socketId, cur);
      room.options = { ...waiting.options, ...opts };
      room.players.push(socket.id);
      room.state = 'playing';

      players.get(waiting.socketId).roomId = room.id;
      player.roomId = room.id;

      const sock1 = io.sockets.sockets.get(waiting.socketId);
      if (sock1) sock1.join(room.id);
      socket.join(room.id);

      persistActiveRoom(room).catch(()=>{});
      startGame(room);
    } else {
      // Player deposited and is now waiting — allow refunding them if they
      // leave before a match is found.
      allowPayee(player.walletAddress);
      const entry = {
        socketId: socket.id,
        walletAddress: player.walletAddress,
        bet, currency: cur, txSignature, options: opts, gameType,
        gridSize: gridSize || null,
        createdAt: Date.now(),
      };
      matchQueue.set(queueKey, entry);
      persistence.saveQueueEntry(queueKey, entry).catch(()=>{});
      socket.emit('waiting', { msg: 'Waiting for an opponent...', betAmount: bet, gameType, currency: cur });
    }
    broadcastLobby();
  });

  socket.on('find_match_house', async ({ gameType, betAmount, txSignature }) => {
    try {
      const player = players.get(socket.id);
      if (!player) return socket.emit('error_msg', { msg: 'Register first' });
      if (player.roomId) return socket.emit('error_msg', { msg: 'You are already in a game' });

      // House closed for maintenance — reject before any payment/logic. PvP is
      // unaffected (this only gates vs-house games).
      if (houseMaintenance) {
        socket.emit('house_maintenance', { msg: houseMaintenanceMsg });
        return socket.emit('error_msg', { msg: houseMaintenanceMsg });
      }

      // Abuse guard FIRST — before we accept any payment / start any logic.
      // Refuses blacklisted wallets, enforces cooldown, daily caps, and a
      // temp-ban for wallets winning too many recent vs-house games.
      const ip = (socket.handshake && (socket.handshake.headers['x-forwarded-for']
                  || socket.handshake.address)) || null;
      const ipKey = ip ? String(ip).split(',')[0].trim() : null;
      const guard = houseAbuse.canStartGame(player.walletAddress, ipKey);
      if (!guard.ok) {
        console.warn('[abuse] Blocked find_match_house from', player.walletAddress, ipKey || '', '-', guard.error);
        return socket.emit('error_msg', { msg: guard.error });
      }

      if (!houseBot.isSupportedGame(gameType)) {
        return socket.emit('error_msg', { msg: 'House mode not available for this game yet' });
      }

      const bet = parseFloat(betAmount) || 0;
      if (!bet || bet <= 0) return socket.emit('error_msg', { msg: 'Invalid bet amount' });
      if (bet > HOUSE_MAX_ZOOT_BET) return socket.emit('error_msg', { msg: 'House bet cannot exceed ' + HOUSE_MAX_ZOOT_BET.toLocaleString() + ' $ZOOT' });

      const escrowZoot = await getEscrowZootBalance();
      const exposed = totalCommittedHouseBets();
      const liquidityNeeded = bet * (HOUSE_PAYOUT_MULTIPLIER - 1) + bet * 0.05;
      if (escrowZoot - exposed < liquidityNeeded) {
        return socket.emit('error_msg', { msg: 'House is short on $ZOOT for this bet — try a smaller amount or play vs another player' });
      }

      if (!TEST_MODE) {
        if (!txSignature) return socket.emit('error_msg', { msg: 'No payment transaction provided' });
        const verification = await verifyBetPayment(txSignature, bet, 'ZOOT');
        if (!verification.ok) return socket.emit('error_msg', { msg: verification.error });
      }

      const room = createRoom(gameType, bet, socket.id, 'ZOOT');
      room.vsHouse = true;
      room.players = [socket.id, houseBot.HOUSE_SOCKET_ID];
      room.houseAgent = houseBot.agents.pickAgent(player.walletAddress);
      // Rig the luck games in the house's favor. The game classes read these
      // from options and bias their RNG so the human wins PLAYER_WIN_PROB_VS_HOUSE.
      room.options = { ...(room.options || {}), vsHouse: true, playerWinProb: PLAYER_WIN_PROB_VS_HOUSE };
      room.state = 'playing';
      player.roomId = room.id;
      socket.join(room.id);

      committedHouseBets.set(room.id, bet);
      room.houseIp = ipKey;
      houseAbuse.recordGameStart(player.walletAddress, ipKey);
      persistActiveRoom(room).catch(()=>{});
      startGame(room);
      broadcastLobby();
    } catch (e) {
      console.error('find_match_house error:', e);
      socket.emit('error_msg', { msg: 'Failed to start house game: ' + e.message });
    }
  });

  socket.on('cancel_search', async () => {
    for (const [key, val] of matchQueue) {
      if (val.socketId === socket.id) {
        const player = players.get(socket.id);
        matchQueue.delete(key);
        persistence.removeQueueEntry(key).catch(()=>{});
        if (player) {
          await refundUser({
            walletAddress: player.walletAddress,
            currency: val.currency || 'SOL',
            amount: val.bet,
            reason: 'Search cancelled',
            socketId: socket.id,
          });
        }
        break;
      }
    }
    socket.emit('search_cancelled');
    broadcastLobby();
  });

  socket.on('accept_bet', async ({ betId, txSignature }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });

    const entry = matchQueue.get(betId);
    if (!entry) return socket.emit('error_msg', { msg: 'This bet is no longer available' });

    if (entry.socketId === socket.id) return socket.emit('error_msg', { msg: 'You cannot accept your own bet' });

    const bet = entry.bet;
    const cur = entry.currency || 'SOL';

    if (!TEST_MODE) {
      if (!txSignature) return socket.emit('error_msg', { msg: 'No payment transaction provided' });
      const verification = await verifyBetPayment(txSignature, bet, cur);
      if (!verification.ok) return socket.emit('error_msg', { msg: verification.error });
    }

    if (!matchQueue.has(betId)) return socket.emit('error_msg', { msg: 'Bet was taken by someone else' });
    matchQueue.delete(betId);
    persistence.removeQueueEntry(betId).catch(()=>{});

    const gameType = entry.gameType || betId.split('_')[0];
    const opts = entry.options || {};

    const room = createRoom(gameType, bet, entry.socketId, cur);
    room.options = opts;
    room.players.push(socket.id);
    room.state = 'playing';

    const waitingPlayer = players.get(entry.socketId);
    if (waitingPlayer) waitingPlayer.roomId = room.id;
    player.roomId = room.id;

    const sock1 = io.sockets.sockets.get(entry.socketId);
    if (sock1) sock1.join(room.id);
    socket.join(room.id);

    persistActiveRoom(room).catch(()=>{});
    startGame(room);
    broadcastLobby();
  });

  socket.on('game_action', async (action) => {
    const player = players.get(socket.id);
    if (!player || !player.roomId) return;
    const room = rooms.get(player.roomId);
    if (!room || !room.game) return;

    const playerIndex = room.players.indexOf(socket.id);
    const result = room.game.handleAction(playerIndex, action);
    if (result.error) return socket.emit('error_msg', { msg: result.error });

    emitGameState(room);

    if (result.gameOver) {
      await handleGameOver(room, result);
    } else if (result.newRound || !result.roundOver) {
      startTurnTimer(room);
    }
  });

  socket.on('create_sports_bet', async ({ eventId, matchName, league, sportKey, pick, teamName, betAmount, txSignature, currency }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });

    const cur = currency === 'ZOOT' ? 'ZOOT' : 'SOL';
    const bet = parseFloat(betAmount) || 0;
    if (!TEST_MODE) {
      if (!bet || bet <= 0) return socket.emit('error_msg', { msg: 'Invalid bet amount' });
      if (!txSignature) return socket.emit('error_msg', { msg: 'No payment transaction provided' });
      const verification = await verifyBetPayment(txSignature, bet, cur);
      if (!verification.ok) return socket.emit('error_msg', { msg: verification.error });
    }

    const betId = 'sb_' + uuidv4().slice(0, 8);
    const sbEntry = {
      id: betId,
      eventId,
      matchName: matchName || 'Unknown Match',
      league: league || '',
      sportKey: sportKey || '',
      pick,
      teamName: teamName || pick,
      betAmount: bet,
      currency: cur,
      creatorSocketId: socket.id,
      creatorWallet: player.walletAddress,
      creatorName: player.displayName,
      txSignature,
      createdAt: Date.now(),
      status: 'open',
    };
    sportsBets.set(betId, sbEntry);
    persistence.saveSportsBet(betId, sbEntry).catch(()=>{});
    allowPayee(player.walletAddress); // deposited — eligible for refund/payout

    socket.emit('sports_bet_created', { betId, betAmount: bet, currency: cur });
    broadcastLobby();
  });

  socket.on('accept_sports_bet', async ({ betId, txSignature }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });

    const entry = sportsBets.get(betId);
    if (!entry) return socket.emit('error_msg', { msg: 'This sports bet is no longer available' });
    if (entry.status !== 'open') return socket.emit('error_msg', { msg: 'This bet has already been taken' });
    if (entry.creatorSocketId === socket.id) return socket.emit('error_msg', { msg: 'You cannot accept your own bet' });

    const bet = entry.betAmount;
    const cur = entry.currency || 'SOL';
    if (!TEST_MODE) {
      if (!txSignature) return socket.emit('error_msg', { msg: 'No payment transaction provided' });
      const verification = await verifyBetPayment(txSignature, bet, cur);
      if (!verification.ok) return socket.emit('error_msg', { msg: verification.error });
    }

    entry.status = 'matched';
    entry.acceptorSocketId = socket.id;
    entry.acceptorWallet = player.walletAddress;
    entry.acceptorName = player.displayName;
    entry.acceptTxSignature = txSignature;
    allowPayee(player.walletAddress); // deposited — eligible for payout
    entry.acceptorPick = entry.pick === 'home' ? 'away' : (entry.pick === 'away' ? 'home' : 'not-draw');
    entry.matchedAt = Date.now();
    persistence.saveSportsBet(entry.id, entry).catch(()=>{});

    const pot = bet * 2;
    const houseCut = pot * HOUSE_FEE;
    const payout = pot - houseCut;

    const creatorSock = io.sockets.sockets.get(entry.creatorSocketId);
    if (creatorSock) creatorSock.emit('sports_bet_matched', { betId, acceptorName: entry.acceptorName, payout, currency: cur });

    socket.emit('sports_bet_accepted', { betId, matchName: entry.matchName, payout, currency: cur });
    broadcastLobby();
  });

  socket.on('cancel_sports_bet', async ({ betId }) => {
    const player = players.get(socket.id);
    if (!player) return;

    const entry = sportsBets.get(betId);
    if (!entry || entry.creatorSocketId !== socket.id || entry.status !== 'open') return;

    sportsBets.delete(betId);
    persistence.removeSportsBet(betId).catch(()=>{});

    await refundUser({
      walletAddress: player.walletAddress,
      currency: entry.currency || 'SOL',
      amount: entry.betAmount,
      reason: 'Sports bet cancelled',
      socketId: socket.id,
    });
    broadcastLobby();
  });

  socket.on('get_lobby', () => broadcastLobby());

  socket.on('get_predictions', () => socket.emit('predictions_update', buildMarketsPayload()));

  // Create a YES/NO offer on a market. Mirrors create_sports_bet.
  socket.on('create_prediction_bet', async ({ marketId, side, betAmount, txSignature, currency }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });

    const market = predictionMarkets.get(marketId);
    if (!market) return socket.emit('error_msg', { msg: 'Market not found' });
    if (market.status !== 'open') return socket.emit('error_msg', { msg: 'This market is closed for betting' });
    if (market.closesAt && Date.now() > market.closesAt) return socket.emit('error_msg', { msg: 'Betting on this market has closed' });

    const pick = String(side || '').toUpperCase();
    if (pick !== 'YES' && pick !== 'NO') return socket.emit('error_msg', { msg: 'Pick YES or NO' });

    const cur = currency === 'ZOOT' ? 'ZOOT' : 'SOL';
    const bet = parseFloat(betAmount) || 0;
    if (!TEST_MODE) {
      if (!bet || bet <= 0) return socket.emit('error_msg', { msg: 'Invalid bet amount' });
      if (!txSignature) return socket.emit('error_msg', { msg: 'No payment transaction provided' });
      const verification = await verifyBetPayment(txSignature, bet, cur);
      if (!verification.ok) return socket.emit('error_msg', { msg: verification.error });
    }

    const betId = 'pb_' + uuidv4().slice(0, 8);
    const entry = {
      id: betId, marketId, side: pick,
      betAmount: bet, currency: cur,
      creatorSocketId: socket.id, creatorWallet: player.walletAddress, creatorName: player.displayName,
      txSignature, createdAt: Date.now(), status: 'open',
    };
    predictionBets.set(betId, entry);
    persistence.savePredictionBet(betId, entry).catch(()=>{});
    allowPayee(player.walletAddress);

    socket.emit('prediction_bet_created', { betId, betAmount: bet, currency: cur, side: pick });
    broadcastPredictions();
  });

  // Take the opposite side of an open offer. Mirrors accept_sports_bet.
  socket.on('accept_prediction_bet', async ({ betId, txSignature }) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('error_msg', { msg: 'Register first' });

    const entry = predictionBets.get(betId);
    if (!entry) return socket.emit('error_msg', { msg: 'This offer is no longer available' });
    if (entry.status !== 'open') return socket.emit('error_msg', { msg: 'This offer has already been taken' });
    if (entry.creatorSocketId === socket.id) return socket.emit('error_msg', { msg: 'You cannot accept your own offer' });

    const market = predictionMarkets.get(entry.marketId);
    if (!market || market.status === 'resolved') return socket.emit('error_msg', { msg: 'This market is no longer available' });

    const bet = entry.betAmount;
    const cur = entry.currency || 'SOL';
    if (!TEST_MODE) {
      if (!txSignature) return socket.emit('error_msg', { msg: 'No payment transaction provided' });
      const verification = await verifyBetPayment(txSignature, bet, cur);
      if (!verification.ok) return socket.emit('error_msg', { msg: verification.error });
    }

    entry.status = 'matched';
    entry.acceptorSocketId = socket.id;
    entry.acceptorWallet = player.walletAddress;
    entry.acceptorName = player.displayName;
    entry.acceptTxSignature = txSignature;
    entry.acceptorSide = entry.side === 'YES' ? 'NO' : 'YES';
    entry.matchedAt = Date.now();
    allowPayee(player.walletAddress);
    persistence.savePredictionBet(entry.id, entry).catch(()=>{});

    const pot = bet * 2;
    const payout = pot - pot * HOUSE_FEE;
    const creatorSock = io.sockets.sockets.get(entry.creatorSocketId);
    if (creatorSock) creatorSock.emit('prediction_bet_matched', { betId, acceptorName: entry.acceptorName, payout, currency: cur });
    socket.emit('prediction_bet_accepted', { betId, payout, currency: cur, side: entry.acceptorSide });
    broadcastPredictions();
  });

  // Creator cancels their own still-open offer and gets refunded.
  socket.on('cancel_prediction_bet', async ({ betId }) => {
    const player = players.get(socket.id);
    if (!player) return;
    const entry = predictionBets.get(betId);
    if (!entry || entry.creatorSocketId !== socket.id || entry.status !== 'open') return;
    predictionBets.delete(betId);
    persistence.removePredictionBet(betId).catch(()=>{});
    await refundUser({
      walletAddress: player.walletAddress, currency: entry.currency || 'SOL',
      amount: entry.betAmount, reason: 'Prediction offer cancelled', socketId: socket.id,
    });
    broadcastPredictions();
  });

  socket.on('chat_message', (data) => {
    try {
      const player = players.get(socket.id);
      if (!player || !player.roomId) return;
      const room = rooms.get(player.roomId);
      if (!room || room.state !== 'playing') return;

      let text = String((data && data.text) || '').trim();
      if (!text) return;
      if (text.length > 200) text = text.slice(0, 200);
      text = text.replace(/[<>]/g, '');

      const now = Date.now();
      let bucket = chatBuckets.get(socket.id) || [];
      bucket = bucket.filter((t) => now - t < 10000);
      if (bucket.length >= 6) {
        socket.emit('chat_message', {
          from: 'System',
          text: 'Slow down — too many messages. Try again in a few seconds.',
          ts: now,
          system: true,
        });
        return;
      }
      bucket.push(now);
      chatBuckets.set(socket.id, bucket);

      io.to(room.id).emit('chat_message', {
        from: player.displayName,
        walletAddress: player.walletAddress,
        text: text,
        ts: now,
        socketId: socket.id,
      });
    } catch (e) {
      console.error('chat_message error', e);
    }
  });

  socket.on('disconnect', async () => {
    console.log(`Disconnected: ${socket.id}`);
    chatBuckets.delete(socket.id);
    const player = players.get(socket.id);

    for (const [key, val] of matchQueue) {
      if (val.socketId === socket.id) {
        matchQueue.delete(key);
        persistence.removeQueueEntry(key).catch(()=>{});
        if (player) {
          await refundUser({
            walletAddress: player.walletAddress,
            currency: val.currency || 'SOL',
            amount: val.bet,
            reason: 'Disconnected while waiting',
            socketId: null,
          });
        }
        break;
      }
    }

    if (player && player.roomId) {
      const room = rooms.get(player.roomId);
      if (room && room.state === 'playing') {
        if (room.vsHouse) {
          if (room._houseTimer) { clearTimeout(room._houseTimer); room._houseTimer = null; }
          clearTurnTimer(room);
          committedHouseBets.delete(room.id);
          room.state = 'finished';
          persistence.removeActiveRoom(room.id).catch(()=>{});
          if (player && player.walletAddress) {
            houseBot.agents.recordResult(player.walletAddress, 'L', room.houseAgent && room.houseAgent.id);
            houseAbuse.recordGameResult(player.walletAddress, 'L', -(room.betAmount || 0));
          }
          console.log('vsHouse player disconnected — house keeps the bet');
          setTimeout(() => cleanupRoom(room.id), 3000);
          players.delete(socket.id);
          broadcastLobby();
          return;
        }
        const remainingIdx = room.players.indexOf(socket.id) === 0 ? 1 : 0;
        const winnerSocketId = room.players[remainingIdx];
        const winnerPlayer = players.get(winnerSocketId);

        const pot = room.betAmount * 2;
        const houseCut = pot * HOUSE_FEE;
        const payout = pot - houseCut;
        const currency = room.currency || 'SOL';

        if (winnerPlayer && !TEST_MODE) {
          try {
            await sendCurrency(currency, winnerPlayer.walletAddress, payout);
            const winSock = io.sockets.sockets.get(winnerSocketId);
            if (winSock) winSock.emit('balance_update', { refreshWallet: true, msg: 'Opponent left — you won ' + payout.toFixed(3) + ' ' + currency + '!' });
          } catch (e) {
            console.error('Payout on disconnect, queuing:', e.message);
            try { await enqueueRefund({ walletAddress: winnerPlayer.walletAddress, currency, amount: payout, reason: 'Opponent disconnect payout', retries: 0, lastError: e.message }); } catch (_) {}
          }
          try {
            await sendCurrency(currency, HOUSE_WALLET, houseCut);
            console.log('House fee sent:', houseCut.toFixed(4), currency, 'to', HOUSE_WALLET);
          } catch (e) {
            console.error('House fee on disconnect, queuing:', e.message);
            try { await enqueueRefund({ walletAddress: HOUSE_WALLET, currency, amount: houseCut, reason: 'House fee', retries: 0, lastError: e.message }); } catch (_) {}
          }
        }

        io.to(room.id).emit('game_over', {
          winner: winnerPlayer ? winnerPlayer.displayName : null,
          winnerWallet: winnerPlayer ? winnerPlayer.walletAddress : null,
          payout, currency, isDraw: false, reason: 'Opponent disconnected',
        });
        room.state = 'finished';
        persistence.removeActiveRoom(room.id).catch(()=>{});
        setTimeout(() => cleanupRoom(room.id), 3000);
      }
    }

    for (const [sbId, sb] of sportsBets) {
      if (sb.creatorSocketId === socket.id && sb.status === 'open') {
        sportsBets.delete(sbId);
        persistence.removeSportsBet(sbId).catch(()=>{});
        if (player) {
          await refundUser({
            walletAddress: player.walletAddress,
            currency: sb.currency || 'SOL',
            amount: sb.betAmount,
            reason: 'Disconnected before bet matched',
            socketId: null,
          });
        }
      }
    }

    players.delete(socket.id);
    broadcastLobby();
  });
});

function startGame(room) {
  if (room.gameType === 'domino') room.game = new DominoGame();
  else if (room.gameType === 'tictactoe') room.game = new TicTacToeGame();
  else if (room.gameType === 'mancala') room.game = new MancalaGame();
  else if (room.gameType === 'checkers') room.game = new CheckersGame();
  else if (room.gameType === 'chess') room.game = new ChessGame();
  else if (room.gameType === 'morpion') room.game = new MorpionGame();
  else if (room.gameType === 'war') room.game = new WarGame();
  else if (room.gameType === 'speed') room.game = new SpeedGame();
  else if (room.gameType === 'poker') room.game = new PokerGame();
  else if (room.gameType === 'reversi') room.game = new ReversiGame();
  else if (room.gameType === 'connect4') room.game = new Connect4Game();
  else if (room.gameType === 'battleship') room.game = new BattleshipGame();
  else if (room.gameType === 'backgammon') room.game = new BackgammonGame();
  else if (room.gameType === 'rps') room.game = new RPSGame();
  else if (room.gameType === 'coinflip') room.game = new CoinFlipGame();
  else if (room.gameType === 'diceduel') room.game = new DiceDuelGame();
  else if (room.gameType === 'hilo') room.game = new HiLoGame();
  else if (room.gameType === 'dotsboxes') room.game = new DotsBoxesGame();
  else if (room.gameType === 'nim') room.game = new NimGame();
  else if (room.gameType === 'hex') room.game = new HexGame();
  else if (room.gameType === 'reaction') room.game = new ReactionGame();
  else if (room.gameType === 'memory') room.game = new MemoryGame();
  else if (room.gameType === 'mathduel') room.game = new MathDuelGame();
  room.game.init(room.players.length, room.options || {});

  // Register every human in this room as an allowed payout target — they have
  // a stake in escrow, so they may legitimately receive a win payout or refund.
  // (The house bot's pseudo-socket has no real wallet, so it's skipped.)
  for (const sid of room.players) {
    const p = players.get(sid);
    if (p && p.walletAddress) allowPayee(p.walletAddress);
  }

  room.players.forEach((sid, idx) => {
    const sock = io.sockets.sockets.get(sid);
    if (sock) {
      const p1 = players.get(room.players[0]);
      const p2 = players.get(room.players[1]);
      const playerInfo = [
        { username: p1?.displayName, wallet: p1?.walletAddress },
        { username: p2?.displayName, wallet: p2?.walletAddress },
      ];
      if (room.vsHouse) {
        const a = room.houseAgent;
        playerInfo[1] = a
          ? { username: a.displayName, wallet: a.walletDisplay, avatar: a.avatar }
          : { username: houseBot.HOUSE_DISPLAY_NAME, wallet: houseBot.HOUSE_WALLET_DISPLAY };
      }
      sock.emit('game_start', {
        roomId: room.id, gameType: room.gameType, betAmount: room.betAmount, currency: room.currency || 'SOL', playerIndex: idx,
        players: playerInfo,
        vsHouse: !!room.vsHouse,
      });
    }
  });
  emitGameState(room);
  startTurnTimer(room);
}

function emitGameState(room) {
  room.players.forEach((sid, idx) => {
    const sock = io.sockets.sockets.get(sid);
    if (sock) sock.emit('game_state', room.game.getStateForPlayer(idx));
  });
  if (room.vsHouse) scheduleHouseMove(room);
}

// Bet size capped tightly to limit single-game escrow exposure. With the old
// 100k cap, a 5-game lucky streak could drain 470k+ ZOOT before the abuse
// guard tripped. 10k keeps the worst-case 24h loss bounded.
const HOUSE_MAX_ZOOT_BET = 10000;
// Payout multiplier on a player win. 1.80x ⇒ player nets +0.80x bet on win
// and -1x on loss ⇒ ~10% house edge per game (was 3%). This is the single
// biggest lever against variance drain.
const HOUSE_PAYOUT_MULTIPLIER = 1.80;

// Target house win rate for the rigged luck games (coinflip / diceduel / hilo)
// in vs-house mode. The player is wired to win exactly (1 - HOUSE_WIN_RATE) of
// the time. Override via env; clamped to a sane range.
const HOUSE_WIN_RATE = Math.min(0.95, Math.max(0.5, parseFloat(process.env.HOUSE_WIN_RATE || '0.75')));
const PLAYER_WIN_PROB_VS_HOUSE = 1 - HOUSE_WIN_RATE;

const committedHouseBets = new Map(); // roomId -> bet amount

async function getEscrowZootBalance() {
  try {
    if (!zootEscrowAta) return 0;
    const bal = await solanaConnection.getTokenAccountBalance(zootEscrowAta);
    return parseFloat(bal.value.uiAmount) || 0;
  } catch (e) {
    console.error('getEscrowZootBalance error:', e.message);
    return 0;
  }
}

function totalCommittedHouseBets() {
  let sum = 0;
  for (const v of committedHouseBets.values()) sum += v;
  return sum;
}

function scheduleHouseMove(room) {
  if (!room || !room.vsHouse || !room.game || room.game.gameOver || room.state !== 'playing') return;
  if (room._houseTimer) return; // already scheduled

  const housePlayerIndex = 1;
  const agent = room.houseAgent;
  const action = houseBot.decideAction(room.game, room.gameType, housePlayerIndex, agent);
  if (!action) {
    if (room.gameType === 'reaction' && room.game.phase === 'waiting' && room.game.signalTime) {
      const wait = room.game.signalTime - Date.now() + houseBot.getActionDelay('reaction', room.game, agent);
      room._houseTimer = setTimeout(() => {
        room._houseTimer = null;
        scheduleHouseMove(room);
      }, Math.max(50, wait));
    }
    return;
  }

  const delay = houseBot.getActionDelay(room.gameType, room.game, agent, action);
  room._houseTimer = setTimeout(() => {
    room._houseTimer = null;
    if (!rooms.has(room.id) || room.game.gameOver || room.state !== 'playing') return;
    try {
      let result;
      if (action && action.type === '__bot_auto') {
        // Defer to the game's own auto-play (random-legal-move or built-in
        // heuristic). May return null if the bot can't actually act yet.
        if (typeof room.game.autoPlayForTimeout !== 'function') {
          console.warn('houseBot: game has no autoPlayForTimeout:', room.gameType);
          return;
        }
        result = room.game.autoPlayForTimeout(housePlayerIndex);
        if (!result) return; // bot couldn't move this tick — just wait
      } else {
        result = room.game.handleAction(housePlayerIndex, action);
      }
      if (result && result.error) {
        console.warn('houseBot action rejected:', room.gameType, action, result.error);
        return;
      }
      emitGameState(room);
      if (result && result.gameOver) {
        handleGameOver(room, result);
      }
    } catch (e) {
      console.error('houseBot apply error:', e);
    }
  }, delay);
}

function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearTurnTimer(room);
  room.players.forEach((sid) => {
    const p = players.get(sid);
    if (p) p.roomId = null;
    const s = io.sockets.sockets.get(sid);
    if (s) s.leave(roomId);
  });
  rooms.delete(roomId);
}

function broadcastLobby() {
  const waiting = [];
  for (const [key, val] of matchQueue) {
    const p = players.get(val.socketId);
    waiting.push({
      id: key,
      gameType: val.gameType || key.split('_')[0],
      betAmount: val.bet,
      currency: val.currency || 'SOL',
      username: p?.displayName || 'Anon',
      wallet: p?.walletAddress ? p.walletAddress.slice(0, 4) + '…' + p.walletAddress.slice(-4) : '',
      gridSize: val.gridSize || null,
      socketId: val.socketId,
    });
  }
  const activeGames = [];
  for (const [, room] of rooms) {
    if (room.state === 'playing') {
      activeGames.push({ gameType: room.gameType, betAmount: room.betAmount, currency: room.currency || 'SOL', players: room.players.map((sid) => players.get(sid)?.displayName) });
    }
  }
  const openSportsBets = [];
  for (const [, sb] of sportsBets) {
    if (sb.status === 'open') {
      openSportsBets.push({
        id: sb.id,
        eventId: sb.eventId,
        matchName: sb.matchName,
        league: sb.league,
        sportKey: sb.sportKey,
        pick: sb.pick,
        teamName: sb.teamName,
        betAmount: sb.betAmount,
        currency: sb.currency || 'SOL',
        creatorName: sb.creatorName,
        creatorWallet: sb.creatorWallet ? sb.creatorWallet.slice(0, 4) + '…' + sb.creatorWallet.slice(-4) : '',
        creatorSocketId: sb.creatorSocketId,
        createdAt: sb.createdAt,
      });
    }
  }
  io.emit('lobby_update', { waiting, activeGames, onlineCount: players.size, openSportsBets });
}

// ── Prediction market helpers ───────────────────────────────────────────────
function _maskWallet(w) {
  return w ? w.slice(0, 4) + '…' + w.slice(-4) : '';
}

// Build the public snapshot: every market plus its open offers and volume stats.
function buildMarketsPayload() {
  const byMarket = new Map();
  for (const [, b] of predictionBets) {
    if (!byMarket.has(b.marketId)) byMarket.set(b.marketId, []);
    byMarket.get(b.marketId).push(b);
  }
  const markets = [];
  for (const [, m] of predictionMarkets) {
    const bets = byMarket.get(m.id) || [];
    const openOffers = [];
    let yesVolume = 0, noVolume = 0, matchedVolume = 0, matchedCount = 0;
    for (const b of bets) {
      if (b.status === 'open') {
        if (b.side === 'YES') yesVolume += b.betAmount; else noVolume += b.betAmount;
        openOffers.push({
          id: b.id, marketId: b.marketId, side: b.side,
          betAmount: b.betAmount, currency: b.currency,
          creatorName: b.creatorName, creatorWallet: _maskWallet(b.creatorWallet),
          creatorSocketId: b.creatorSocketId, createdAt: b.createdAt,
        });
      } else if (b.status === 'matched') {
        matchedVolume += b.betAmount * 2;
        matchedCount++;
      }
    }
    openOffers.sort((a, b) => b.createdAt - a.createdAt);
    markets.push({
      id: m.id, question: m.question, description: m.description, category: m.category,
      status: m.status, outcome: m.outcome,
      closesAt: m.closesAt, resolvesAt: m.resolvesAt, createdAt: m.createdAt, resolvedAt: m.resolvedAt,
      isAuto: !!m.auto, autoProvider: m.auto ? m.auto.provider : null,
      openOffers,
      stats: { yesVolume, noVolume, matchedVolume, matchedCount, openCount: openOffers.length },
    });
  }
  // Open/closed first (newest first), resolved markets after (most recently resolved first).
  markets.sort((a, b) => {
    const ar = a.status === 'resolved' ? 1 : 0;
    const br = b.status === 'resolved' ? 1 : 0;
    if (ar !== br) return ar - br;
    if (ar) return (b.resolvedAt || 0) - (a.resolvedAt || 0);
    return b.createdAt - a.createdAt;
  });
  return { markets };
}

function broadcastPredictions() {
  io.emit('predictions_update', buildMarketsPayload());
}

// Settle a market: pay the winning side 1.8x, send the house its 10% rake,
// refund unmatched offers, and (for CANCEL) refund both sides of matched bets.
async function settlePredictionMarket(market, outcome) {
  market.status = 'resolved';
  market.outcome = outcome;
  market.resolvedAt = Date.now();
  persistence.savePredictionMarket(market.id, market).catch(()=>{});

  const related = [];
  for (const [, b] of predictionBets) if (b.marketId === market.id) related.push(b);

  let paid = 0, refunded = 0, houseFees = 0;

  for (const b of related) {
    const cur = b.currency || 'SOL';
    try {
      if (b.status === 'open') {
        // Unmatched offer — return the creator's stake regardless of outcome.
        await refundUser({
          walletAddress: b.creatorWallet, currency: cur, amount: b.betAmount,
          reason: 'Prediction market resolved — unmatched offer refunded',
          socketId: b.creatorSocketId,
        });
        refunded++;
      } else if (b.status === 'matched') {
        if (outcome === 'CANCEL') {
          for (const side of [['creatorWallet', 'creatorSocketId'], ['acceptorWallet', 'acceptorSocketId']]) {
            await refundUser({
              walletAddress: b[side[0]], currency: cur, amount: b.betAmount,
              reason: 'Prediction market cancelled — stake refunded', socketId: b[side[1]],
            });
          }
          refunded += 2;
        } else {
          const creatorWon = b.side === outcome;
          const winnerWallet = creatorWon ? b.creatorWallet : b.acceptorWallet;
          const winnerSocketId = creatorWon ? b.creatorSocketId : b.acceptorSocketId;
          const pot = b.betAmount * 2;
          const houseCut = pot * HOUSE_FEE;
          const payout = pot - houseCut;
          allowPayee(winnerWallet);
          try {
            await sendCurrency(cur, winnerWallet, payout);
            paid++;
            const ws = winnerSocketId && io.sockets.sockets.get(winnerSocketId);
            if (ws) ws.emit('balance_update', { refreshWallet: true, msg: 'You won ' + payout + ' ' + cur + ' on "' + market.question + '"!' });
          } catch (e) {
            console.error('Prediction payout failed, queuing:', e.message);
            await enqueueRefund({ walletAddress: winnerWallet, currency: cur, amount: payout, reason: 'Prediction payout', retries: 0, lastError: e.message });
          }
          try {
            await sendCurrency(cur, HOUSE_WALLET, houseCut);
            houseFees += houseCut;
          } catch (e) {
            console.error('Prediction house fee failed, queuing:', e.message);
            await enqueueRefund({ walletAddress: HOUSE_WALLET, currency: cur, amount: houseCut, reason: 'House fee (prediction)', retries: 0, lastError: e.message });
          }
          const ls = (creatorWon ? b.acceptorSocketId : b.creatorSocketId);
          const lsock = ls && io.sockets.sockets.get(ls);
          if (lsock) lsock.emit('balance_update', { refreshWallet: true, msg: 'Market "' + market.question + '" resolved ' + outcome + '. Better luck next time!' });
        }
      }
    } catch (e) {
      console.error('Prediction settlement error for bet', b.id, '-', e.message);
    }
    predictionBets.delete(b.id);
    persistence.removePredictionBet(b.id).catch(()=>{});
  }

  console.log('[markets] resolved', market.id, outcome, '— paid:', paid, 'refunded:', refunded, 'houseFees:', houseFees);
  broadcastPredictions();
  return { outcome, paid, refunded, houseFees };
}

/**
 * Recover from previous run: anything left in the persistence store is, by
 * definition, orphaned — either a player was waiting for an opponent, or a
 * game was active when the process died. Refund all of them; the funds are
 * safely held in the escrow wallet and will be returned to the rightful
 * owners. Pending refunds are kicked off immediately on boot.
 */
async function recoverFromPreviousRun() {
  if (!persistence.isEnabled()) {
    console.log('Persistence disabled — skipping startup recovery (set FIREBASE_SERVICE_ACCOUNT to enable).');
    return;
  }
  console.log('Persistence enabled — running startup recovery...');

  try {
    const orphanQueue = await persistence.loadQueue();
    if (orphanQueue.length) console.log('Found', orphanQueue.length, 'orphaned waiting bet(s) — refunding...');
    for (const entry of orphanQueue) {
      if (entry.walletAddress && entry.bet) {
        allowPayee(entry.walletAddress);
        await refundUser({
          walletAddress: entry.walletAddress,
          currency: entry.currency || 'SOL',
          amount: entry.bet,
          reason: 'Server restarted while you were waiting',
          socketId: null,
        });
      }
      await persistence.removeQueueEntry(entry.id);
    }
  } catch (e) { console.error('Recovery (queue) error:', e.message); }

  try {
    const orphanRooms = await persistence.loadActiveRooms();
    if (orphanRooms.length) console.log('Found', orphanRooms.length, 'orphaned active room(s) — refunding both players...');
    for (const r of orphanRooms) {
      const list = r.players || [];
      for (const p of list) {
        if (p.walletAddress && r.betAmount) {
          allowPayee(p.walletAddress);
          await refundUser({
            walletAddress: p.walletAddress,
            currency: r.currency || 'SOL',
            amount: r.betAmount,
            reason: 'Game interrupted by server restart',
            socketId: null,
          });
        }
      }
      await persistence.removeActiveRoom(r.id);
    }
  } catch (e) { console.error('Recovery (active rooms) error:', e.message); }

  try {
    const orphanSports = await persistence.loadSportsBets();
    let restored = 0, refunded = 0;
    for (const sb of orphanSports) {
      if (sb.status === 'open') {
        sb.creatorSocketId = null;
        sportsBets.set(sb.id, sb);
        allowPayee(sb.creatorWallet); // may reconnect & cancel for a refund
        restored++;
      } else if (sb.status === 'matched') {
        for (const wallet of [sb.creatorWallet, sb.acceptorWallet]) {
          if (wallet && sb.betAmount) {
            allowPayee(wallet);
            await refundUser({
              walletAddress: wallet,
              currency: sb.currency || 'SOL',
              amount: sb.betAmount,
              reason: 'Sports bet interrupted by server restart',
              socketId: null,
            });
          }
        }
        await persistence.removeSportsBet(sb.id);
        refunded++;
      }
    }
    if (restored) console.log('Restored', restored, 'open sports bet(s).');
    if (refunded) console.log('Refunded', refunded, 'matched sports bet(s) from previous run.');
  } catch (e) { console.error('Recovery (sports bets) error:', e.message); }

  try {
    const markets = await persistence.loadPredictionMarkets();
    for (const m of markets) predictionMarkets.set(m.id, m);
    const pbets = await persistence.loadPredictionBets();
    let openRestored = 0, matchedRestored = 0;
    for (const b of pbets) {
      // Matched prediction bets are KEPT across restarts (unlike sports) — they
      // settle later when the market is resolved, with funds safe in escrow.
      b.creatorSocketId = null;
      if (b.status === 'matched') { b.acceptorSocketId = null; matchedRestored++; }
      else openRestored++;
      allowPayee(b.creatorWallet);
      if (b.acceptorWallet) allowPayee(b.acceptorWallet);
      predictionBets.set(b.id, b);
    }
    if (markets.length) console.log('Restored', markets.length, 'prediction market(s).');
    if (openRestored || matchedRestored) console.log('Restored prediction bets — open:', openRestored, 'matched:', matchedRestored);
  } catch (e) { console.error('Recovery (prediction markets) error:', e.message); }

  try {
    const pendings = await persistence.listPendingRefunds(100);
    knownPendingRefunds = pendings.length;
    if (pendings.length) console.log('Found', pendings.length, 'pending refund(s) from previous run — will retry automatically.');
  } catch (_) {}

  console.log('Startup recovery complete.');
  processPendingRefunds().catch(()=>{});
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log(`ZG (Zoot Games) running on http://localhost:${PORT}`);
  try { await recoverFromPreviousRun(); } catch (e) { console.error('Recovery failed:', e.message); }

  // Live TV: load the free IPTV playlist in the background (refreshes every 6h).
  if (process.env.TV_DISABLE !== '1') tv.init();

  // Smart agent: auto-open prediction markets from free live feeds and
  // auto-resolve them from the same feeds. P2P even-money, so no house risk.
  marketAgent.start({
    createMarket: (opts) => createPredictionMarket(opts),
    listMarkets: () => Array.from(predictionMarkets.values()),
    resolveMarket: async (id, outcome) => {
      const m = predictionMarkets.get(id);
      if (!m || m.status === 'resolved') return;
      // If nobody participated, retire it quietly so the "Resolved" tab only
      // shows markets people actually traded.
      let hasBets = false;
      for (const [, b] of predictionBets) { if (b.marketId === id) { hasBets = true; break; } }
      if (!hasBets) {
        predictionMarkets.delete(id);
        persistence.removePredictionMarket(id).catch(() => {});
        broadcastPredictions();
        return;
      }
      return settlePredictionMarket(m, outcome);
    },
  });
});

app.get('/api/refunds/pending', async (req, res) => {
  if (!persistence.isEnabled()) return res.json({ enabled: false, pending: [] });
  try {
    const list = await persistence.listPendingRefunds(50);
    res.json({ enabled: true, pending: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
