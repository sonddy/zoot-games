'use strict';

const HOUSE_SOCKET_ID = '__HOUSE_BOT__';
const HOUSE_DISPLAY_NAME = 'House';
const HOUSE_WALLET_DISPLAY = 'HOUSE';

// All 24 games supported in vs-house mode. For games not in CUSTOM_AI below,
// the bot defers to that game's `autoPlayForTimeout(playerIndex)` method,
// which already implements a sensible (usually random / heuristic) move
// picker. The 1.94x payout (vs the fair 2.0x) gives the house ~3% edge on
// chance-driven games; strategy-heavy games rely on the bot beating
// less-skilled players plus the same payout edge for skilled ones.
const SUPPORTED_GAMES = [
  'rps', 'coinflip', 'diceduel', 'hilo', 'reaction', 'mathduel',
  'tictactoe', 'morpion', 'connect4', 'dotsboxes', 'nim', 'hex',
  'checkers', 'chess', 'reversi', 'mancala', 'backgammon',
  'domino', 'war', 'speed', 'memory', 'battleship', 'poker',
];

// Sentinel action that tells server/index.js to call
// `room.game.autoPlayForTimeout(playerIndex)` instead of handleAction(...).
const BOT_AUTO = { type: '__bot_auto' };

function isSupportedGame(gameType) {
  return SUPPORTED_GAMES.includes(gameType);
}

function rand(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// Returns true when the bot should consider acting right now for `gameType`.
// Used as a cheap pre-filter so we don't burn timers on no-ops.
function botCanAct(game, gameType, idx) {
  if (!game || game.gameOver) return false;
  switch (gameType) {
    case 'rps':
      return game.choices && game.choices[idx] === null && (game.currentPlayer === idx || game.currentPlayer === undefined);
    case 'coinflip':
      // Player 0 always picks; the house never acts.
      return false;
    case 'diceduel':
      return !(game.rolled && game.rolled[idx]);
    case 'hilo':
      return game.currentPlayer === idx;
    case 'reaction':
      return game.phase === 'waiting' && !(game.reacted && game.reacted[idx]);
    case 'mathduel':
      return !(game.answered && game.answered[idx]);
    case 'war':
      return !(game.flipped && game.flipped[idx]) && game.hands && game.hands[idx] && game.hands[idx].length > 0;
    case 'speed':
      // Speed is real-time — try every tick.
      return true;
    case 'memory':
      return game.currentPlayer === idx;
    case 'battleship':
      return game.phase === 'shoot' && game.currentPlayer === idx;
    case 'backgammon':
      return game.currentPlayer === idx && !game.awaitingRoll && !game.gameOver;
    case 'poker':
      return game.currentPlayer === idx && game.phase !== 'showdown' && !game.gameOver;
    case 'domino':
      return game.currentPlayer === idx && !game.roundOver;
    // Default turn-based check.
    default:
      return game.currentPlayer === idx;
  }
}

// Decide what the bot does on its turn. May return:
//   - null: nothing to do right now
//   - { type: '__bot_auto' }: server should call game.autoPlayForTimeout(idx)
//   - { type: '...specific...' }: server should call game.handleAction(idx, action)
function decideAction(game, gameType, housePlayerIndex) {
  if (!game || game.gameOver) return null;
  const idx = housePlayerIndex;
  if (!botCanAct(game, gameType, idx)) return null;

  switch (gameType) {
    case 'rps': {
      const opts = ['rock', 'paper', 'scissors'];
      return { type: 'choose', choice: opts[rand(0, 2)] };
    }
    case 'coinflip':
      return null;
    case 'diceduel':
      return { type: 'roll' };
    case 'hilo':
      return { type: 'guess', guess: Math.random() < 0.5 ? 'higher' : 'lower' };
    case 'reaction': {
      const now = Date.now();
      if (!game.signalTime || now < game.signalTime) return null;
      return { type: 'react' };
    }
    case 'mathduel': {
      // 65% correct gives a fair, beatable bot; the 3% edge comes from payout.
      const correct = Math.random() < 0.65;
      let value;
      if (correct) value = game.answer;
      else {
        const sign = Math.random() < 0.5 ? -1 : 1;
        value = game.answer + sign * rand(1, 10);
      }
      return { type: 'answer', value };
    }
    case 'war':
      return { type: 'flip' };
    // Everything else defers to the game's own auto-play (random-legal-move
    // or simple heuristic the game already ships with).
    default:
      return BOT_AUTO;
  }
}

// Returns a human-like delay (ms) before the bot performs its decided action.
function getActionDelay(gameType, game) {
  switch (gameType) {
    case 'rps':       return rand(900, 2000);
    case 'hilo':      return rand(1000, 2200);
    case 'diceduel':  return rand(700, 1600);
    case 'mathduel':  return rand(2000, 4500);
    case 'war':       return rand(600, 1400);
    case 'reaction': {
      const now = Date.now();
      const sigTime = (game && game.signalTime) || now;
      const reactDelayFromSignal = rand(250, 550);
      const fromNow = (sigTime - now) + reactDelayFromSignal;
      return Math.max(50, fromNow);
    }
    // Strategy games — thinking time scales with complexity.
    case 'chess':     return rand(2500, 5500);
    case 'checkers':  return rand(1800, 4000);
    case 'reversi':   return rand(1500, 3200);
    case 'mancala':   return rand(1200, 2800);
    case 'backgammon':return rand(1800, 3800);
    case 'connect4':  return rand(1200, 2500);
    case 'dotsboxes': return rand(1000, 2200);
    case 'nim':       return rand(900, 2000);
    case 'hex':       return rand(1500, 3200);
    case 'morpion':   return rand(1200, 2500);
    case 'tictactoe': return rand(800, 1800);
    case 'domino':    return rand(1500, 3000);
    case 'poker':     return rand(2000, 4500);
    case 'battleship':return rand(1500, 3500);
    case 'memory':    return rand(1200, 2600);
    case 'speed':     return rand(700, 1500);
    case 'coinflip':
    default:          return 1000;
  }
}

module.exports = {
  HOUSE_SOCKET_ID,
  HOUSE_DISPLAY_NAME,
  HOUSE_WALLET_DISPLAY,
  SUPPORTED_GAMES,
  BOT_AUTO,
  isSupportedGame,
  decideAction,
  getActionDelay,
  botCanAct,
};
