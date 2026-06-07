'use strict';

// ════════════════════════════════════════════════════════════════════
// HOUSE ABUSE GUARD
//
// Defends the escrow $ZOOT against draining by:
//  1. A hard blacklist (specific wallets banned from vs-house entirely).
//  2. Per-wallet cooldown — minimum N seconds between vs-house games.
//  3. Per-wallet daily volume cap.
//  4. Win-rate ban — if a wallet wins too many vs-house games in a row,
//     they're temporarily blocked (assumed bot / exploit).
//
// All limits are in-memory; resets on server restart. That's intentional —
// we'd rather lose a few minutes of tracking on restart than persist false
// positives forever.
// ════════════════════════════════════════════════════════════════════

// Wallets that are PERMANENTLY blocked from vs-house play. These were
// observed draining the escrow with automation or pattern abuse.
const HARD_BLACKLIST = new Set([
  'ZLWUuLcQwTSYa9yayprVVpAZu9y2jzyy9u5CqUwkw2D',
]);

// Hard per-wallet limits. Tightened after observed drain — old values
// (30/hr, 100/day) permitted abusive volume.
const MIN_GAP_BETWEEN_GAMES_MS = 45_000;   // 45s cooldown between vs-house starts
const MAX_GAMES_PER_HOUR = 12;             // hard rolling 1h cap
const MAX_GAMES_PER_DAY = 40;              // rolling 24h cap

// Daily NET winnings cap (in ZOOT). Once a wallet has won more than this
// from vs-house games in the rolling 24h window, vs-house is disabled.
// This is the hard backstop against variance drain.
const MAX_NET_WIN_PER_DAY_ZOOT = 60_000;

// Win-rate based ban. After this many recent games, if the wallet's win rate
// exceeds the threshold, they get a temporary timeout. Both trigger and ban
// duration are tightened.
const WIN_RATE_WINDOW = 8;                 // look at last 8 vs-house results
const WIN_RATE_TRIGGER = 0.55;             // 5+/8 wins triggers cooldown
const WIN_STREAK_TRIGGER = 3;              // OR 3 wins in a row
const WIN_RATE_BAN_MS = 24 * 60 * 60 * 1000;  // 24h temp ban (was 1h)

// Per-IP rate limiting (basic sybil defense across wallets on same machine).
// Independently caps how many vs-house games can be started from a single
// remote address regardless of how many wallets they cycle through.
const MAX_GAMES_PER_HOUR_PER_IP = 18;
const MAX_GAMES_PER_DAY_PER_IP = 60;
const ipTracker = new Map(); // ip -> timestamps[]

// In-memory tracking. Each entry is per wallet.
//   timestamps:    number[]  recent game start times (ms epoch), pruned to 24h
//   results:       ('W'|'L'|'D')[]  recent outcomes, capped at 20
//   netWinEvents:  [{t:ms, delta:number}]  signed net change in ZOOT per game
//   bannedUntil:   number    ms epoch when temp ban expires (0 if not banned)
const tracker = new Map();

function _now() { return Date.now(); }

function _entry(wallet) {
  let e = tracker.get(wallet);
  if (!e) { e = { timestamps: [], results: [], netWinEvents: [], bannedUntil: 0 }; tracker.set(wallet, e); }
  return e;
}

function _pruneTimestamps(e, now) {
  const cutoff = now - 24 * 60 * 60 * 1000;
  while (e.timestamps.length > 0 && e.timestamps[0] < cutoff) e.timestamps.shift();
  while (e.netWinEvents.length > 0 && e.netWinEvents[0].t < cutoff) e.netWinEvents.shift();
}

function _pruneIp(ip, now) {
  let list = ipTracker.get(ip);
  if (!list) { list = []; ipTracker.set(ip, list); }
  const cutoff = now - 24 * 60 * 60 * 1000;
  while (list.length > 0 && list[0] < cutoff) list.shift();
  return list;
}

function _netWin24h(e) {
  let sum = 0;
  for (const ev of e.netWinEvents) sum += ev.delta;
  return sum;
}

function _winStreak(results) {
  let n = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    if (results[i] === 'W') n++; else break;
  }
  return n;
}

// Checks whether `wallet` is allowed to start a new vs-house game right now.
// Returns { ok: true } or { ok: false, error: 'message', retryAfterMs?: number }.
// `ip` is optional; when provided we also enforce per-IP rate limits.
function canStartGame(wallet, ip) {
  if (!wallet) return { ok: false, error: 'No wallet attached' };
  if (HARD_BLACKLIST.has(wallet)) {
    return { ok: false, error: 'This wallet is not allowed to play vs the house. Contact support if you believe this is an error.' };
  }

  const now = _now();
  const e = _entry(wallet);
  _pruneTimestamps(e, now);

  if (e.bannedUntil && now < e.bannedUntil) {
    const leftMin = Math.ceil((e.bannedUntil - now) / 60000);
    return { ok: false, error: `Vs-house play temporarily disabled for this wallet (suspicious win pattern). Try again in ~${leftMin} min.`, retryAfterMs: e.bannedUntil - now };
  }

  // Cooldown between games
  if (e.timestamps.length > 0) {
    const lastStart = e.timestamps[e.timestamps.length - 1];
    const gap = now - lastStart;
    if (gap < MIN_GAP_BETWEEN_GAMES_MS) {
      const left = Math.ceil((MIN_GAP_BETWEEN_GAMES_MS - gap) / 1000);
      return { ok: false, error: `Slow down — wait ${left}s before starting another vs-house game.`, retryAfterMs: MIN_GAP_BETWEEN_GAMES_MS - gap };
    }
  }

  // Rolling hour rate
  const hourCutoff = now - 60 * 60 * 1000;
  const lastHourCount = e.timestamps.filter(t => t >= hourCutoff).length;
  if (lastHourCount >= MAX_GAMES_PER_HOUR) {
    return { ok: false, error: `Hourly vs-house limit reached (${MAX_GAMES_PER_HOUR}/hr). Try again later.` };
  }

  // Rolling daily cap
  if (e.timestamps.length >= MAX_GAMES_PER_DAY) {
    return { ok: false, error: `Daily vs-house limit reached (${MAX_GAMES_PER_DAY}/day). Try again tomorrow.` };
  }

  // Net daily winnings cap — the backstop against variance drain.
  const netWin = _netWin24h(e);
  if (netWin >= MAX_NET_WIN_PER_DAY_ZOOT) {
    return { ok: false, error: `Daily vs-house winnings cap reached (${MAX_NET_WIN_PER_DAY_ZOOT.toLocaleString()} $ZOOT). Try again tomorrow.` };
  }

  // Per-IP rate limit (sybil defense)
  if (ip) {
    const ipList = _pruneIp(ip, now);
    const ipLastHour = ipList.filter(t => t >= hourCutoff).length;
    if (ipLastHour >= MAX_GAMES_PER_HOUR_PER_IP) {
      return { ok: false, error: `Hourly vs-house limit reached for this device (${MAX_GAMES_PER_HOUR_PER_IP}/hr). Try again later.` };
    }
    if (ipList.length >= MAX_GAMES_PER_DAY_PER_IP) {
      return { ok: false, error: `Daily vs-house limit reached for this device (${MAX_GAMES_PER_DAY_PER_IP}/day). Try again tomorrow.` };
    }
  }

  return { ok: true };
}

// Call this when a vs-house game STARTS (after canStartGame passed).
function recordGameStart(wallet, ip) {
  if (!wallet) return;
  const now = _now();
  const e = _entry(wallet);
  e.timestamps.push(now);
  if (ip) {
    const list = _pruneIp(ip, now);
    list.push(now);
  }
}

// Call this when a vs-house game ENDS with outcome 'W' | 'L' | 'D'.
// `netDeltaZoot` is the wallet's net change in ZOOT for this game (positive
// when the player won, negative when they lost, zero on draw / refund).
// (W means the PLAYER won, i.e. the house paid out.)
function recordGameResult(wallet, outcome, netDeltaZoot) {
  if (!wallet) return;
  const e = _entry(wallet);
  e.results.push(outcome);
  if (e.results.length > WIN_RATE_WINDOW * 2) e.results.shift();
  if (typeof netDeltaZoot === 'number' && !isNaN(netDeltaZoot)) {
    e.netWinEvents.push({ t: _now(), delta: netDeltaZoot });
  }

  // Trigger temp ban if win pattern is suspicious
  const recent = e.results.slice(-WIN_RATE_WINDOW);
  if (recent.length >= WIN_RATE_WINDOW) {
    const wins = recent.filter(r => r === 'W').length;
    const winRate = wins / recent.length;
    if (winRate >= WIN_RATE_TRIGGER) {
      e.bannedUntil = _now() + WIN_RATE_BAN_MS;
      console.warn(`[abuse] Wallet ${wallet} hit win-rate trigger (${wins}/${recent.length}). Temp-banned for ${WIN_RATE_BAN_MS / 60000} min.`);
      return;
    }
  }
  if (_winStreak(e.results) >= WIN_STREAK_TRIGGER) {
    e.bannedUntil = _now() + WIN_RATE_BAN_MS;
    console.warn(`[abuse] Wallet ${wallet} hit win-streak trigger (${_winStreak(e.results)} in a row). Temp-banned for ${WIN_RATE_BAN_MS / 60000} min.`);
  }
}

function isBlacklisted(wallet) { return HARD_BLACKLIST.has(wallet); }

module.exports = {
  HARD_BLACKLIST,
  MIN_GAP_BETWEEN_GAMES_MS,
  MAX_GAMES_PER_HOUR,
  MAX_GAMES_PER_DAY,
  MAX_NET_WIN_PER_DAY_ZOOT,
  MAX_GAMES_PER_HOUR_PER_IP,
  MAX_GAMES_PER_DAY_PER_IP,
  canStartGame,
  recordGameStart,
  recordGameResult,
  isBlacklisted,
};
