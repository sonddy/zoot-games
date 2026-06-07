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

// Hard per-wallet limits.
const MIN_GAP_BETWEEN_GAMES_MS = 20_000;   // 20s cooldown between vs-house starts
const MAX_GAMES_PER_HOUR = 30;             // hard daily-rate cap (rolling 1h)
const MAX_GAMES_PER_DAY = 100;             // rolling 24h cap

// Win-rate based ban. After this many recent games, if the wallet's win rate
// exceeds the threshold, they get a temporary timeout.
const WIN_RATE_WINDOW = 10;                // look at last 10 vs-house results
const WIN_RATE_TRIGGER = 0.65;             // 7+/10 wins triggers cooldown
const WIN_STREAK_TRIGGER = 5;              // OR 5 wins in a row
const WIN_RATE_BAN_MS = 60 * 60 * 1000;    // 1h temp ban

// In-memory tracking. Each entry is per wallet.
//   timestamps:  number[]  recent game start times (ms epoch), pruned to 24h
//   results:     ('W'|'L'|'D')[]  recent outcomes, capped at 20
//   bannedUntil: number    ms epoch when temp ban expires (0 if not banned)
const tracker = new Map();

function _now() { return Date.now(); }

function _entry(wallet) {
  let e = tracker.get(wallet);
  if (!e) { e = { timestamps: [], results: [], bannedUntil: 0 }; tracker.set(wallet, e); }
  return e;
}

function _pruneTimestamps(e, now) {
  const cutoff = now - 24 * 60 * 60 * 1000;
  while (e.timestamps.length > 0 && e.timestamps[0] < cutoff) e.timestamps.shift();
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
function canStartGame(wallet) {
  if (!wallet) return { ok: false, error: 'No wallet attached' };
  if (HARD_BLACKLIST.has(wallet)) {
    return { ok: false, error: 'This wallet is not allowed to play vs the house. Contact support if you believe this is an error.' };
  }

  const now = _now();
  const e = _entry(wallet);
  _pruneTimestamps(e, now);

  if (e.bannedUntil && now < e.bannedUntil) {
    const left = Math.ceil((e.bannedUntil - now) / 60000);
    return { ok: false, error: `Vs-house play temporarily disabled for this wallet (suspicious win pattern). Try again in ~${left} min.`, retryAfterMs: e.bannedUntil - now };
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

  return { ok: true };
}

// Call this when a vs-house game STARTS (after canStartGame passed).
function recordGameStart(wallet) {
  if (!wallet) return;
  const e = _entry(wallet);
  e.timestamps.push(_now());
}

// Call this when a vs-house game ENDS with outcome 'W' | 'L' | 'D'
// (W means the PLAYER won, i.e. the house paid out).
function recordGameResult(wallet, outcome) {
  if (!wallet) return;
  const e = _entry(wallet);
  e.results.push(outcome);
  if (e.results.length > WIN_RATE_WINDOW * 2) e.results.shift();

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
  canStartGame,
  recordGameStart,
  recordGameResult,
  isBlacklisted,
};
