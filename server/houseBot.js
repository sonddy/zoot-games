'use strict';

const HOUSE_SOCKET_ID = '__HOUSE_BOT__';
const HOUSE_DISPLAY_NAME = 'House';
const HOUSE_WALLET_DISPLAY = 'HOUSE';

// Games where the player can play 1-on-1 against the house bot.
// Limited to chance / quick-reflex games where a fair random bot is enough.
const SUPPORTED_GAMES = ['rps', 'coinflip', 'diceduel', 'hilo', 'reaction', 'mathduel'];

function isSupportedGame(gameType) {
  return SUPPORTED_GAMES.includes(gameType);
}

function rand(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// Pick the next action for the bot (housePlayerIndex is always 1 in vs-house rooms).
// Returns null when nothing to do right now (game over, not bot's turn yet, or
// nothing for the bot to do for this game type).
function decideAction(game, gameType, housePlayerIndex) {
  if (!game || game.gameOver) return null;

  switch (gameType) {
    case 'rps': {
      if (game.choices && game.choices[housePlayerIndex] !== null) return null;
      if (game.currentPlayer !== housePlayerIndex) return null;
      const opts = ['rock', 'paper', 'scissors'];
      return { type: 'choose', choice: opts[rand(0, 2)] };
    }

    case 'coinflip': {
      // Game design: only player index 0 picks the side; the house never acts.
      return null;
    }

    case 'diceduel': {
      if (game.rolled && game.rolled[housePlayerIndex]) return null;
      return { type: 'roll' };
    }

    case 'hilo': {
      if (game.currentPlayer !== housePlayerIndex) return null;
      return { type: 'guess', guess: Math.random() < 0.5 ? 'higher' : 'lower' };
    }

    case 'reaction': {
      if (game.phase !== 'waiting') return null;
      if (game.reacted && game.reacted[housePlayerIndex]) return null;
      const now = Date.now();
      if (!game.signalTime || now < game.signalTime) return null;
      return { type: 'react' };
    }

    case 'mathduel': {
      if (game.answered && game.answered[housePlayerIndex]) return null;
      // 65% correct gives a fair, beatable bot — the 3% edge comes from the payout
      const correct = Math.random() < 0.65;
      let value;
      if (correct) {
        value = game.answer;
      } else {
        const sign = Math.random() < 0.5 ? -1 : 1;
        value = game.answer + sign * rand(1, 10);
      }
      return { type: 'answer', value: value };
    }
  }
  return null;
}

// How long to wait before the bot performs its action — keeps the bot
// from feeling robotic. For 'reaction' the delay is computed from the
// signal time so the bot reacts in a human-like 250-550 ms window.
function getActionDelay(gameType, game) {
  switch (gameType) {
    case 'rps':
      return rand(900, 2000);
    case 'hilo':
      return rand(1000, 2200);
    case 'diceduel':
      return rand(700, 1600);
    case 'reaction': {
      const now = Date.now();
      const sigTime = (game && game.signalTime) || now;
      const reactDelayFromSignal = rand(250, 550);
      const fromNow = (sigTime - now) + reactDelayFromSignal;
      return Math.max(50, fromNow);
    }
    case 'mathduel':
      return rand(2000, 4500);
    case 'coinflip':
    default:
      return 1000;
  }
}

module.exports = {
  HOUSE_SOCKET_ID,
  HOUSE_DISPLAY_NAME,
  HOUSE_WALLET_DISPLAY,
  SUPPORTED_GAMES,
  isSupportedGame,
  decideAction,
  getActionDelay,
};
