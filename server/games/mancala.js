const TURN_TIME_MS = 20000;

class MancalaGame {
  constructor() {
    this.pits = [];
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
  }

  init(numPlayers, options = {}) {
    this.pits = [4, 4, 4, 4, 4, 4, 0, 4, 4, 4, 4, 4, 4, 0];
    this.currentPlayer = Math.random() < 0.5 ? 0 : 1;
    this.turnStartTime = Date.now();
  }

  _store(player) { return player === 0 ? 6 : 13; }
  _pitsRange(player) { return player === 0 ? [0, 5] : [7, 12]; }
  _oppStore(player) { return player === 0 ? 13 : 6; }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };
    if (action.type === 'resign') {
      this.gameOver = true;
      this.winner = 1 - playerIndex;
      return { gameOver: true, winner: this.winner, resigned: true };
    }
    if (playerIndex !== this.currentPlayer) return { error: 'Not your turn' };
    if (action.type !== 'sow') return { error: 'Invalid action' };

    const pitIndex = action.pit;
    const [lo, hi] = this._pitsRange(playerIndex);
    if (pitIndex < lo || pitIndex > hi) return { error: 'Not your pit' };
    if (this.pits[pitIndex] === 0) return { error: 'Pit is empty' };

    const seeds = this.pits[pitIndex];
    this.pits[pitIndex] = 0;
    let pos = pitIndex;
    const oppStoreIdx = this._oppStore(playerIndex);

    for (let i = 0; i < seeds; i++) {
      pos = (pos + 1) % 14;
      if (pos === oppStoreIdx) pos = (pos + 1) % 14;
      this.pits[pos]++;
    }

    const myStore = this._store(playerIndex);
    let extraTurn = pos === myStore;

    if (!extraTurn) {
      const [mlo, mhi] = this._pitsRange(playerIndex);
      if (pos >= mlo && pos <= mhi && this.pits[pos] === 1) {
        const opposite = 12 - pos;
        if (this.pits[opposite] > 0) {
          this.pits[myStore] += this.pits[opposite] + 1;
          this.pits[opposite] = 0;
          this.pits[pos] = 0;
        }
      }
    }

    if (this._isSideEmpty(0) || this._isSideEmpty(1)) {
      this._collectRemaining();
      this.gameOver = true;
      if (this.pits[6] > this.pits[13]) this.winner = 0;
      else if (this.pits[13] > this.pits[6]) this.winner = 1;
      else this.winner = playerIndex;
      return { gameOver: true, winner: this.winner };
    }

    if (!extraTurn) this.currentPlayer = 1 - this.currentPlayer;
    this.turnStartTime = Date.now();
    return { gameOver: false, extraTurn };
  }

  _isSideEmpty(player) {
    const [lo, hi] = this._pitsRange(player);
    for (let i = lo; i <= hi; i++) { if (this.pits[i] > 0) return false; }
    return true;
  }

  _collectRemaining() {
    for (let p = 0; p < 2; p++) {
      const [lo, hi] = this._pitsRange(p);
      const store = this._store(p);
      for (let i = lo; i <= hi; i++) { this.pits[store] += this.pits[i]; this.pits[i] = 0; }
    }
  }

  autoPlayForTimeout(playerIndex) {
    const [lo, hi] = this._pitsRange(playerIndex);
    for (let i = lo; i <= hi; i++) {
      if (this.pits[i] > 0) return this.handleAction(playerIndex, { type: 'sow', pit: i });
    }
    return null;
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);
    return {
      gameType: 'mancala',
      pits: this.pits.slice(),
      currentPlayer: this.currentPlayer,
      isMyTurn: !this.gameOver && this.currentPlayer === playerIndex,
      playerIndex,
      scores: [this.pits[6], this.pits[13]],
      gameOver: this.gameOver,
      winner: this.winner,
      turnTimeMs: TURN_TIME_MS,
      turnRemainingMs: remaining,
    };
  }
}

module.exports = MancalaGame;
