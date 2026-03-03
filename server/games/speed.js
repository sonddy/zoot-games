const TURN_TIME_MS = 20000;
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const RANK_VALUES = { 'A':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13 };

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

function isAdjacent(v1, v2) {
  const diff = Math.abs(v1 - v2);
  return diff === 1 || diff === 12;
}

class SpeedGame {
  constructor() {
    this.hands = [[], []];
    this.piles = [null, null];
    this.drawPiles = [[], []];
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
    this.lastPlayTime = [0, 0];
    this.stalledCount = 0;
  }

  init(numPlayers, options = {}) {
    const deck = shuffle(createDeck());
    this.hands[0] = deck.slice(0, 5);
    this.hands[1] = deck.slice(5, 10);
    this.drawPiles[0] = deck.slice(10, 26);
    this.drawPiles[1] = deck.slice(26, 42);
    this.piles = [deck[42], deck[43]];
    this.extraCards = deck.slice(44);
    this.turnStartTime = Date.now();
    this.lastPlayTime = [Date.now(), Date.now()];
  }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };
    if (action.type === 'resign') {
      this.gameOver = true;
      this.winner = 1 - playerIndex;
      return { gameOver: true, winner: this.winner, resigned: true };
    }

    if (action.type === 'play') {
      const { handIndex, pileIndex } = action;
      if (handIndex < 0 || handIndex >= this.hands[playerIndex].length) return { error: 'Invalid card' };
      if (pileIndex < 0 || pileIndex > 1) return { error: 'Invalid pile' };

      const card = this.hands[playerIndex][handIndex];
      const pileCard = this.piles[pileIndex];

      if (!isAdjacent(card.value, pileCard.value)) return { error: 'Card must be adjacent in rank' };

      this.piles[pileIndex] = card;
      this.hands[playerIndex].splice(handIndex, 1);
      this.lastPlayTime[playerIndex] = Date.now();
      this.stalledCount = 0;

      if (this.drawPiles[playerIndex].length > 0) {
        this.hands[playerIndex].push(this.drawPiles[playerIndex].shift());
      }

      if (this.hands[playerIndex].length === 0 && this.drawPiles[playerIndex].length === 0) {
        this.gameOver = true;
        this.winner = playerIndex;
        return { gameOver: true, winner: playerIndex };
      }

      this.turnStartTime = Date.now();
      return { gameOver: false, played: true };
    }

    return { error: 'Invalid action' };
  }

  autoPlayForTimeout(playerIndex) {
    this.stalledCount++;
    if (this.stalledCount >= 4) {
      if (this.extraCards.length >= 2) {
        this.piles[0] = this.extraCards.shift();
        this.piles[1] = this.extraCards.shift();
        this.stalledCount = 0;
        this.turnStartTime = Date.now();
        return { gameOver: false, newPileCards: true };
      }
      const s0 = this.hands[0].length + this.drawPiles[0].length;
      const s1 = this.hands[1].length + this.drawPiles[1].length;
      this.gameOver = true;
      if (s0 < s1) this.winner = 0;
      else if (s1 < s0) this.winner = 1;
      else this.winner = null;
      return { gameOver: true, winner: this.winner };
    }
    this.turnStartTime = Date.now();
    return { gameOver: false };
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);
    return {
      gameType: 'speed',
      hand: this.hands[playerIndex],
      oppHandCount: this.hands[1 - playerIndex].length,
      piles: this.piles,
      myDrawLeft: this.drawPiles[playerIndex].length,
      oppDrawLeft: this.drawPiles[1 - playerIndex].length,
      isMyTurn: !this.gameOver,
      playerIndex,
      currentPlayer: 0,
      gameOver: this.gameOver,
      winner: this.winner,
      turnTimeMs: TURN_TIME_MS,
      turnRemainingMs: remaining,
    };
  }
}

module.exports = SpeedGame;
