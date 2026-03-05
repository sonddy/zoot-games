const TURN_TIME_MS = 20000;

class NimGame {
  constructor() {
    this.piles = [];
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
    this.lastMove = null;
  }

  init(numPlayers, options = {}) {
    this.piles = [1, 3, 5, 7];
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.lastMove = null;
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

    if (action.type === 'take') {
      const { pile, count } = action;
      if (pile < 0 || pile >= this.piles.length) return { error: 'Invalid pile' };
      if (count < 1 || count > this.piles[pile]) return { error: 'Invalid count' };

      this.piles[pile] -= count;
      this.lastMove = { player: playerIndex, pile, count };

      const total = this.piles.reduce((a, b) => a + b, 0);
      if (total === 0) {
        this.gameOver = true;
        this.winner = 1 - playerIndex;
        return { gameOver: true, winner: this.winner };
      }

      this.currentPlayer = 1 - playerIndex;
      this.turnStartTime = Date.now();
      return { gameOver: false };
    }

    return { error: 'Invalid action' };
  }

  autoPlayForTimeout(playerIndex) {
    for (let i = 0; i < this.piles.length; i++) {
      if (this.piles[i] > 0) {
        const count = Math.floor(Math.random() * this.piles[i]) + 1;
        return this.handleAction(playerIndex, { type: 'take', pile: i, count });
      }
    }
    return null;
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);
    return {
      gameType: 'nim',
      piles: this.piles,
      lastMove: this.lastMove,
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

module.exports = NimGame;
