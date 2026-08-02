// ════════════════════════════════════════
// TELEGRAM MINI APP INTEGRATION
// ════════════════════════════════════════
// Three responsibilities:
//
// 1. initData validation — Telegram Mini Apps pass a signed query string
//    (window.Telegram.WebApp.initData) identifying the user. We verify the
//    HMAC per https://core.telegram.org/bots/webapps#validating-data-received
//    so a client can't forge a Telegram identity.
//
// 2. Bot webhook — replies to /start (and any message) with a button that
//    opens the game as a Mini App. Also sets the bot's menu button on boot.
//
// 3. Phantom wallet bridge — inside Telegram's webview the Capacitor-style
//    zootgames:// deeplink return doesn't work. Instead, Phantom redirects to
//    /wallet-return.html in the system browser, which relays the encrypted
//    response here; the Mini App polls /api/wallet-bridge/poll to pick it up.
//    Payloads are end-to-end encrypted by Phantom (nacl box) — this server
//    only ferries opaque ciphertext and never sees keys or plaintext.

const crypto = require('crypto');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || 'https://zootgames.org').replace(/\/+$/, '');
const TG_API = 'https://api.telegram.org/bot' + BOT_TOKEN;

// Webhook secret derived from the bot token — no extra env var needed, and
// Telegram echoes it back in a header so we can reject forged webhook calls.
const WEBHOOK_SECRET = BOT_TOKEN
  ? crypto.createHash('sha256').update('zg-webhook:' + BOT_TOKEN).digest('hex').slice(0, 40)
  : '';

let botUsername = null;

function isEnabled() { return !!BOT_TOKEN; }

// ── initData validation ──────────────────────────────────────────

/**
 * Validates a Telegram Mini App initData string. Returns the Telegram user
 * object ({ id, first_name, username, ... }) on success, or null if the
 * signature is invalid, stale, or malformed.
 */
function validateInitData(initData, maxAgeSeconds = 24 * 60 * 60) {
  if (!BOT_TOKEN || typeof initData !== 'string' || !initData || initData.length > 8192) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();
    if (!crypto.timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;

    const authDate = parseInt(params.get('auth_date') || '0', 10);
    if (!authDate || (Date.now() / 1000) - authDate > maxAgeSeconds) return null;

    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !user.id) return null;
    return user;
  } catch (_) {
    return null;
  }
}

/** Friendly display name for a validated Telegram user. */
function displayNameFor(user) {
  if (user.username) return '@' + user.username;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || ('tg:' + user.id);
}

// ── Bot API ──────────────────────────────────────────────────────

async function tgCall(method, payload) {
  const res = await fetch(TG_API + '/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const json = await res.json().catch(() => null);
  if (!json || !json.ok) {
    throw new Error('Telegram ' + method + ' failed: ' + ((json && json.description) || ('HTTP ' + res.status)));
  }
  return json.result;
}

const HELP_TEXT = [
  'How Zoot Games works:',
  '',
  '1. Tap Play to open the game inside Telegram — you are signed in automatically.',
  '2. Pick any of the 24 games (Chess, Poker, Domino, Backgammon, Connect 4...) and set your bet in SOL or $ZOOT.',
  '3. First bet? You\u2019ll be guided to connect your Phantom wallet (phone only — on desktop, use zootgames.org in a browser).',
  '4. Win and get paid instantly: 1.8x your wager, straight to your wallet.',
  '',
  'Also inside: live sports betting, prediction markets, and free live TV.',
  '',
  '18+ only. Privacy policy: ' + PUBLIC_URL + '/privacy.html',
].join('\n');

const SUPPORT_TEXT = [
  'Need help?',
  '',
  '\u2022 Payout or refund issue: interrupted games and unmatched bets are refunded automatically within a few minutes.',
  '\u2022 Wallet trouble: try Disconnect Wallet in the game menu, then reconnect Phantom.',
  '\u2022 Anything else: describe your problem in one message here (include your wallet address if it\u2019s about a payout) and the team will review it.',
  '',
  'Privacy policy: ' + PUBLIC_URL + '/privacy.html',
].join('\n');

async function handleUpdate(update) {
  const msg = update && update.message;
  if (!msg || !msg.chat || msg.chat.type !== 'private') return;

  const text = (msg.text || '').trim();
  const cmd = text.split(/[\s@]/)[0].toLowerCase();

  let reply;
  if (cmd === '/start') {
    reply = 'Welcome to Zoot Games — 24 live multiplayer games with SOL / $ZOOT betting.\n\nTap the button below to play right here in Telegram.';
  } else if (cmd === '/help') {
    reply = HELP_TEXT;
  } else if (cmd === '/support') {
    reply = SUPPORT_TEXT;
  } else if (cmd === '/play') {
    reply = 'Let\u2019s go — tap the button below.';
  } else {
    reply = 'Tap the button below to open Zoot Games, or use /help to see how it works.';
  }

  await tgCall('sendMessage', {
    chat_id: msg.chat.id,
    text: reply,
    reply_markup: {
      inline_keyboard: [[{ text: 'Play Zoot Games', web_app: { url: PUBLIC_URL } }]],
    },
  });
}

// ── Phantom wallet bridge ────────────────────────────────────────

const bridgeSessions = new Map(); // sid -> { params, createdAt }
const BRIDGE_TTL_MS = 10 * 60 * 1000;
const BRIDGE_MAX_SESSIONS = 1000;
const BRIDGE_ALLOWED_KEYS = ['phantom_encryption_public_key', 'nonce', 'data', 'errorCode', 'errorMessage'];

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of bridgeSessions) {
    if (now - s.createdAt > BRIDGE_TTL_MS) bridgeSessions.delete(sid);
  }
}, 60 * 1000).unref();

function validSid(sid) {
  return typeof sid === 'string' && /^[A-Za-z0-9-]{16,64}$/.test(sid);
}

// ── Express wiring ───────────────────────────────────────────────

function init(app) {
  // Lets the Mini App and wallet-return page discover the bot handle.
  app.get('/api/telegram/info', (req, res) => {
    res.json({ enabled: isEnabled(), botUsername });
  });

  // Phantom redirects the user's browser to /wallet-return.html, which posts
  // the encrypted response here for the Mini App to collect.
  app.post('/api/wallet-bridge/complete', (req, res) => {
    const { sid, params } = req.body || {};
    if (!validSid(sid) || !params || typeof params !== 'object') {
      return res.status(400).json({ error: 'Invalid bridge payload' });
    }
    if (bridgeSessions.has(sid)) return res.status(409).json({ error: 'Already completed' });
    if (bridgeSessions.size >= BRIDGE_MAX_SESSIONS) return res.status(429).json({ error: 'Bridge busy, try again' });

    const clean = {};
    for (const key of BRIDGE_ALLOWED_KEYS) {
      if (typeof params[key] === 'string' && params[key].length <= 8192) clean[key] = params[key];
    }
    bridgeSessions.set(sid, { params: clean, createdAt: Date.now() });
    res.json({ ok: true });
  });

  // One-shot poll: returns and deletes the relayed response.
  app.get('/api/wallet-bridge/poll', (req, res) => {
    const sid = req.query.sid;
    if (!validSid(sid)) return res.status(400).json({ error: 'Invalid sid' });
    const session = bridgeSessions.get(sid);
    if (!session) return res.json({ done: false });
    bridgeSessions.delete(sid);
    res.json({ done: true, params: session.params });
  });

  if (!isEnabled()) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set — Telegram bot disabled (wallet bridge routes still active)');
    return;
  }

  app.post('/telegram/webhook', (req, res) => {
    if (req.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) {
      return res.status(401).end();
    }
    // Ack immediately; Telegram retries on non-200 which we don't want for
    // per-message handler errors.
    res.json({ ok: true });
    handleUpdate(req.body).catch((e) => console.error('[telegram] update error:', e.message));
  });

  setupBot().catch((e) => console.error('[telegram] setup failed:', e.message));
}

async function setupBot() {
  const me = await tgCall('getMe');
  botUsername = me.username;

  await tgCall('setWebhook', {
    url: PUBLIC_URL + '/telegram/webhook',
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ['message'],
  });

  // Menu button (bottom-left in the bot chat) opens the Mini App directly.
  await tgCall('setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Play', web_app: { url: PUBLIC_URL } },
  });

  console.log('[telegram] bot @' + botUsername + ' ready — webhook set to ' + PUBLIC_URL + '/telegram/webhook');
}

module.exports = { init, isEnabled, validateInitData, displayNameFor };
