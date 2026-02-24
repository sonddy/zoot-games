const TURN_TIME_MS = 30000;
const GRID_SIZE = 15;
const WIN_LENGTH = 5;

class MorpionGame {
  constructor() {
    this.board = [];
    this.size = GRID_SIZE;
    this.winLength = WIN_LENGTH;
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.winningCells = [];
    this.turnStartTime = Date.now();
    this.moveCount = 0;
    this.lastMove = null;
  }

  init(numPlayers, options = {}) {
    this.size = options.gridSize || GRID_SIZE;
    this.winLength = WIN_LENGTH;
    this.board = Array(this.size * this.size).fill(null);
    this.currentPlayer = Math.random() < 0.5 ? 0 : 1;
    this.turnStartTime = Date.now();
    this.moveCount = 0;
    this.lastMove = null;
    this.winningCells = [];
  }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };
    if (action.type === 'resign') {
      this.gameOver = true;
      this.winner = 1 - playerIndex;
      return { gameOver: true, winner: this.winner, resigned: true };
    }
    if (playerIndex !== this.currentPlayer) return { error: 'Not your turn' };
    if (action.type !== 'place') return { error: 'Invalid action' };

    const { cell } = action;
    const total = this.size * this.size;
    if (cell < 0 || cell >= total || this.board[cell] !== null) {
      return { error: 'Invalid cell' };
    }

    this.board[cell] = playerIndex;
    this.moveCount++;
    this.lastMove = cell;

    const winResult = this._checkWin(cell, playerIndex);
    if (winResult) {
      this.gameOver = true;
      this.winner = playerIndex;
      this.winningCells = winResult;
      return { gameOver: true, winner: playerIndex };
    }

    if (this.moveCount >= total) {
      this.gameOver = true;
      this.winner = null;
      return { gameOver: true, winner: null };
    }

    this.currentPlayer = 1 - this.currentPlayer;
    this.turnStartTime = Date.now();
    return { gameOver: false };
  }

  _checkWin(cell, player) {
    const s = this.size;
    const r = Math.floor(cell / s);
    const c = cell % s;
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];

    for (const [dr, dc] of directions) {
      const cells = [cell];
      for (let step = 1; step < this.winLength; step++) {
        const nr = r + dr * step, nc = c + dc * step;
        if (nr < 0 || nr >= s || nc < 0 || nc >= s) break;
        if (this.board[nr * s + nc] !== player) break;
        cells.push(nr * s + nc);
      }
      for (let step = 1; step < this.winLength; step++) {
        const nr = r - dr * step, nc = c - dc * step;
        if (nr < 0 || nr >= s || nc < 0 || nc >= s) break;
        if (this.board[nr * s + nc] !== player) break;
        cells.push(nr * s + nc);
      }
      if (cells.length >= this.winLength) return cells;
    }
    return null;
  }

  autoPlayForTimeout(playerIndex) {
    const center = Math.floor(this.size / 2);
    const centerIdx = center * this.size + center;
    if (this.board[centerIdx] === null) {
      return this.handleAction(playerIndex, { type: 'place', cell: centerIdx });
    }

    if (this.lastMove !== null) {
      const lr = Math.floor(this.lastMove / this.size);
      const lc = this.lastMove % this.size;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = lr + dr, nc = lc + dc;
          if (nr >= 0 && nr < this.size && nc >= 0 && nc < this.size) {
            const idx = nr * this.size + nc;
            if (this.board[idx] === null) {
              return this.handleAction(playerIndex, { type: 'place', cell: idx });
            }
          }
        }
      }
    }

    for (let i = 0; i < this.board.length; i++) {
      if (this.board[i] === null) return this.handleAction(playerIndex, { type: 'place', cell: i });
    }
    return null;
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);
    return {
      gameType: 'morpion',
      board: this.board.slice(),
      size: this.size,
      winLength: this.winLength,
      currentPlayer: this.currentPlayer,
      isMyTurn: !this.gameOver && this.currentPlayer === playerIndex,
      playerIndex,
      symbol: playerIndex === 0 ? 'X' : 'O',
      gameOver: this.gameOver,
      winner: this.winner,
      winningCells: this.winningCells,
      lastMove: this.lastMove,
      moveCount: this.moveCount,
      turnTimeMs: TURN_TIME_MS,
      turnRemainingMs: remaining,
    };
  }
}

module.exports = MorpionGame;
