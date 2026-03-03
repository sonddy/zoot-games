const TURN_TIME_MS = 15000;
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

function createDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s, value: RANK_VALUES[r] });
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class WarGame {
  constructor() {
    this.hands = [[], []];
    this.currentCards = [null, null];
    this.warPile = [];
    this.scores = [0, 0];
    this.currentPlayer = 0;
    this.phase = 'flip';
    this.roundNum = 0;
    this.maxRounds = 26;
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
    this.isWar = false;
    this.bothFlipped = false;
  }

  init(numPlayers, options = {}) {
    const deck = shuffle(createDeck());
    this.hands[0] = deck.slice(0, 26);
    this.hands[1] = deck.slice(26);
    this.scores = [0, 0];
    this.currentCards = [null, null];
    this.warPile = [];
    this.isWar = false;
    this.roundNum = 0;
    this.gameOver = false;
    this.winner = null;
    this.currentPlayer = 0;
    this.turnStartTime = Date.now();
    this.flipped = [false, false];
  }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };
    if (action.type === 'resign') {
      this.gameOver = true;
      this.winner = 1 - playerIndex;
      return { gameOver: true, winner: this.winner, resigned: true };
    }
    if (action.type !== 'flip') return { error: 'Invalid action' };
    if (this.flipped[playerIndex]) return { error: 'Already flipped' };
    if (this.hands[playerIndex].length === 0) return { error: 'No cards left' };

    this.flipped[playerIndex] = true;
    this.currentCards[playerIndex] = this.hands[playerIndex].shift();

    if (this.flipped[0] && this.flipped[1]) {
      return this._resolveRound();
    }

    this.currentPlayer = 1 - playerIndex;
    this.turnStartTime = Date.now();
    return { gameOver: false, waitingForOpponent: true };
  }

  _resolveRound() {
    const c0 = this.currentCards[0];
    const c1 = this.currentCards[1];
    this.roundNum++;
    let result;

    if (c0.value > c1.value) {
      this.scores[0] += 1 + this.warPile.length;
      this.warPile = [];
      this.isWar = false;
      result = { roundWinner: 0 };
    } else if (c1.value > c0.value) {
      this.scores[1] += 1 + this.warPile.length;
      this.warPile = [];
      this.isWar = false;
      result = { roundWinner: 1 };
    } else {
      this.warPile.push(c0, c1);
      this.isWar = true;
      result = { roundWinner: null, war: true };
    }

    if (this.hands[0].length === 0 || this.hands[1].length === 0 || this.roundNum >= this.maxRounds) {
      this.gameOver = true;
      if (this.scores[0] > this.scores[1]) this.winner = 0;
      else if (this.scores[1] > this.scores[0]) this.winner = 1;
      else this.winner = null;
      return { gameOver: true, winner: this.winner, ...result };
    }

    this.flipped = [false, false];
    this.currentCards = [null, null];
    this.currentPlayer = 0;
    this.turnStartTime = Date.now();
    return { gameOver: false, newRound: true, ...result };
  }

  autoPlayForTimeout(playerIndex) {
    if (this.gameOver) return null;
    for (let i = 0; i < 2; i++) {
      if (!this.flipped[i] && this.hands[i].length > 0) {
        return this.handleAction(i, { type: 'flip' });
      }
    }
    return null;
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);
    return {
      gameType: 'war',
      myCardsLeft: this.hands[playerIndex].length,
      oppCardsLeft: this.hands[1 - playerIndex].length,
      myCard: this.flipped[playerIndex] ? this.currentCards[playerIndex] : null,
      oppCard: (this.flipped[0] && this.flipped[1]) ? this.currentCards[1 - playerIndex] : null,
      oppFlipped: this.flipped[1 - playerIndex],
      scores: this.scores,
      isWar: this.isWar,
      warPileSize: this.warPile.length,
      roundNum: this.roundNum,
      maxRounds: this.maxRounds,
      canFlip: !this.flipped[playerIndex] && !this.gameOver,
      currentPlayer: this.currentPlayer,
      isMyTurn: !this.flipped[playerIndex] && !this.gameOver,
      playerIndex,
      gameOver: this.gameOver,
      winner: this.winner,
      turnTimeMs: TURN_TIME_MS,
      turnRemainingMs: remaining,
    };
  }
}

module.exports = WarGame;
