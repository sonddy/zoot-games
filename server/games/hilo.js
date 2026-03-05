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

class HiLoGame {
  constructor() {
    this.deck = [];
    this.currentCard = null;
    this.nextCard = null;
    this.currentPlayer = 0;
    this.scores = [0, 0];
    this.round = 0;
    this.maxRounds = 6;
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
    this.lastGuess = null;
    this.lastCorrect = null;
  }

  init(numPlayers, options = {}) {
    this.deck = shuffle(createDeck());
    this.currentCard = this.deck.pop();
    this.nextCard = this.deck.pop();
    this.currentPlayer = 0;
    this.scores = [0, 0];
    this.round = 0;
    this.maxRounds = 6;
    this.gameOver = false;
    this.winner = null;
    this.lastGuess = null;
    this.lastCorrect = null;
    this.turnStartTime = Date.now();
  }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };
    if (action.type === 'resign') {
      this.gameOver = true;
      this.winner = 1 - playerIndex;
      return { gameOver: true, winner: this.winner, resigned: true };
    }
    if (playerIndex !== this.currentPlayer) return { error: 'Not your turn' };
    if (action.type !== 'guess') return { error: 'Invalid action' };
    if (action.guess !== 'higher' && action.guess !== 'lower') return { error: 'Guess higher or lower' };

    const current = this.currentCard.value;
    const next = this.nextCard.value;
    this.round++;

    let correct = false;
    if (action.guess === 'higher' && next >= current) correct = true;
    else if (action.guess === 'lower' && next <= current) correct = true;

    if (correct) this.scores[playerIndex]++;

    this.lastGuess = { player: playerIndex, guess: action.guess, correct, revealed: this.nextCard };

    if (this.round >= this.maxRounds) {
      this.gameOver = true;
      if (this.scores[0] > this.scores[1]) this.winner = 0;
      else if (this.scores[1] > this.scores[0]) this.winner = 1;
      else this.winner = null;
      return { gameOver: true, winner: this.winner };
    }

    this.currentCard = this.nextCard;
    this.nextCard = this.deck.length > 0 ? this.deck.pop() : shuffle(createDeck()).pop();
    this.currentPlayer = 1 - playerIndex;
    this.turnStartTime = Date.now();
    return { gameOver: false };
  }

  autoPlayForTimeout(playerIndex) {
    if (this.gameOver) return null;
    const guess = Math.random() < 0.5 ? 'higher' : 'lower';
    return this.handleAction(playerIndex, { type: 'guess', guess });
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);

    return {
      gameType: 'hilo',
      currentCard: this.currentCard,
      scores: this.scores,
      round: this.round,
      maxRounds: this.maxRounds,
      lastGuess: this.lastGuess,
      currentPlayer: this.currentPlayer,
      isMyTurn: !this.gameOver && this.currentPlayer === playerIndex,
      playerIndex,
      gameOver: this.gameOver,
      winner: this.winner,
      turnTimeMs: TURN_TIME_MS,
      turnRemainingMs: remaining,
    };
  }
}

module.exports = HiLoGame;
