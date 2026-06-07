const TURN_TIME_MS = 30000;

const SYMBOLS = ['🍎','🍊','🍋','🍇','🍓','🍒','🌸','🔥','💎','⭐','🎵','🌙','🎯','🐱','🐶','🦊','🌈','🍀'];

class MemoryGame {
  constructor() {
    this.cards = [];
    this.revealed = [];
    this.matched = [];
    this.flipped = [];
    this.currentPlayer = 0;
    this.scores = [0, 0];
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
    this.totalPairs = 0;
  }

  init(numPlayers, options = {}) {
    this.totalPairs = 12;
    const selected = SYMBOLS.slice(0, this.totalPairs);
    const deck = [...selected, ...selected];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    this.cards = deck;
    this.revealed = Array(deck.length).fill(false);
    this.matched = Array(deck.length).fill(false);
    this.flipped = [];
    this.currentPlayer = 0;
    this.scores = [0, 0];
    this.gameOver = false;
    this.winner = null;
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

    if (action.type === 'flip') {
      const idx = action.index;
      if (idx < 0 || idx >= this.cards.length) return { error: 'Invalid card' };
      if (this.matched[idx]) return { error: 'Already matched' };
      if (this.flipped.includes(idx)) return { error: 'Already flipped' };

      this.flipped.push(idx);
      this.revealed[idx] = true;

      if (this.flipped.length === 2) {
        const [a, b] = this.flipped;
        if (this.cards[a] === this.cards[b]) {
          this.matched[a] = true;
          this.matched[b] = true;
          this.scores[playerIndex]++;
          this.flipped = [];

          if (this.scores[0] + this.scores[1] >= this.totalPairs) {
            this.gameOver = true;
            if (this.scores[0] > this.scores[1]) this.winner = 0;
            else if (this.scores[1] > this.scores[0]) this.winner = 1;
            else this.winner = null;
            return { gameOver: true, winner: this.winner };
          }
          this.turnStartTime = Date.now();
          return { gameOver: false, match: true };
        } else {
          setTimeout(() => {
            this.revealed[a] = false;
            this.revealed[b] = false;
            this.flipped = [];
            this.currentPlayer = 1 - playerIndex;
            this.turnStartTime = Date.now();
          }, 1500);
          return { gameOver: false, noMatch: true };
        }
      }

      this.turnStartTime = Date.now();
      return { gameOver: false };
    }

    return { error: 'Invalid action' };
  }

  autoPlayForTimeout(playerIndex) {
    const available = [];
    for (let i = 0; i < this.cards.length; i++) {
      if (!this.matched[i] && !this.flipped.includes(i)) available.push(i);
    }
    if (available.length === 0) return null;
    const idx = available[Math.floor(Math.random() * available.length)];
    return this.handleAction(playerIndex, { type: 'flip', index: idx });
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);

    const visibleCards = this.cards.map((card, i) => {
      if (this.matched[i] || this.revealed[i]) return card;
      return null;
    });

    return {
      gameType: 'memory',
      cards: visibleCards,
      matched: this.matched,
      flippedCount: this.flipped.length,
      totalPairs: this.totalPairs,
      scores: this.scores,
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

module.exports = MemoryGame;
