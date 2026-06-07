'use strict';

const agents = require('./houseAgents');

const HOUSE_SOCKET_ID = '__HOUSE_BOT__';
// Legacy fallback names — only used if no agent has been assigned to a room.
// In practice, every vsHouse room now gets an agent from houseAgents.pickAgent().
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
//
// `agent` is the per-room houseAgent persona (see server/houseAgents.js).
// Falls back to neutral behavior if no agent provided.
function decideAction(game, gameType, housePlayerIndex, agent) {
  if (!game || game.gameOver) return null;
  const idx = housePlayerIndex;
  if (!botCanAct(game, gameType, idx)) return null;

  // Fallback agent if none supplied (preserves legacy behavior).
  const a = agent || { skill: 3, personality: 'mixed' };

  switch (gameType) {
    case 'rps': {
      // Pull the opponent's pick history across the BO3 from roundResults
      // (set by RPS game on each resolved round). Each entry is
      // { choices: [c0, c1], winner }.
      const opponentIdx = idx === 0 ? 1 : 0;
      let history = [];
      if (Array.isArray(game.roundResults)) {
        history = game.roundResults
          .map(h => (h && h.choices ? h.choices[opponentIdx] : null))
          .filter(Boolean);
      }
      // Include this round's pick if the opponent has already locked in.
      if (game.choices && game.choices[opponentIdx]) history.push(game.choices[opponentIdx]);
      return { type: 'choose', choice: agents.rpsDecision(a, history) };
    }
    case 'coinflip':
      return null;
    case 'diceduel':
      return { type: 'roll' };
    case 'hilo': {
      // currentCard is an object { suit, value }; we want the value (1-13).
      const cardObj = game.currentCard;
      const cardValue = cardObj && typeof cardObj.value === 'number' ? cardObj.value : null;
      return { type: 'guess', guess: agents.hiloDecision(a, cardValue) };
    }
    case 'reaction': {
      const now = Date.now();
      if (!game.signalTime || now < game.signalTime) return null;
      return { type: 'react' };
    }
    case 'mathduel': {
      const plan = agents.mathDuelPlan(a);
      let value;
      if (plan.willBeCorrect) value = game.answer;
      else {
        const sign = Math.random() < 0.5 ? -1 : 1;
        value = game.answer + sign * plan.errorMagnitude;
      }
      return { type: 'answer', value, __solveTimeMs: plan.solveTimeMs };
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
// `agent` is the per-room persona; falls back to neutral skill 3 if absent.
function getActionDelay(gameType, game, agent, action) {
  const a = agent || { skill: 3, personality: 'mixed' };

  // Reaction: jitter around signal time using agent's reaction profile.
  if (gameType === 'reaction') {
    const now = Date.now();
    const sigTime = (game && game.signalTime) || now;
    const reactMs = agents.reactionDelayMs(a);
    const fromNow = (sigTime - now) + reactMs;
    return Math.max(50, fromNow);
  }

  // Math Duel: the decideAction step computed a solve-time plan; honor it
  // so that "skill 5" agents really do answer in ~2s and "skill 1" agents
  // take ~4-5s. Falls back to thinkingDelay if action wasn't precomputed.
  if (gameType === 'mathduel' && action && typeof action.__solveTimeMs === 'number') {
    return action.__solveTimeMs;
  }

  return agents.thinkingDelay(a, gameType, game);
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
  agents,
};
