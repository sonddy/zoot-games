const TURN_TIME_MS = 30000;
const ROWS = 6;
const COLS = 7;

class Connect4Game {
  constructor() {
    this.board = [];
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
    this.lastMove = null;
    this.winLine = null;
  }

  init(numPlayers, options = {}) {
    this.board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.lastMove = null;
    this.winLine = null;
    this.turnStartTime = Date.now();
  }

  _checkWin(row, col, player) {
    const directions = [[0,1],[1,0],[1,1],[1,-1]];
    for (const [dr, dc] of directions) {
      const line = [[row, col]];
      for (let d = 1; d <= 3; d++) {
        const r = row + dr * d, c = col + dc * d;
        if (r >= 0 && r < ROWS && c >= 0 && c < COLS && this.board[r][c] === player) line.push([r, c]);
        else break;
      }
      for (let d = 1; d <= 3; d++) {
        const r = row - dr * d, c = col - dc * d;
        if (r >= 0 && r < ROWS && c >= 0 && c < COLS && this.board[r][c] === player) line.push([r, c]);
        else break;
      }
      if (line.length >= 4) return line;
    }
    return null;
  }

  _isBoardFull() {
    return this.board[0].every(cell => cell !== null);
  }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };
    if (action.type === 'resign') {
      this.gameOver = true;
      this.winner = 1 - playerIndex;
      return { gameOver: true, winner: this.winner, resigned: true };
    }
    if (playerIndex !== this.currentPlayer) return { error: 'Not your turn' };

    if (action.type === 'drop') {
      const col = action.col;
      if (col < 0 || col >= COLS) return { error: 'Invalid column' };
      if (this.board[0][col] !== null) return { error: 'Column is full' };

      let row = ROWS - 1;
      while (row >= 0 && this.board[row][col] !== null) row--;

      this.board[row][col] = playerIndex;
      this.lastMove = { row, col };

      const winLine = this._checkWin(row, col, playerIndex);
      if (winLine) {
        this.gameOver = true;
        this.winner = playerIndex;
        this.winLine = winLine;
        return { gameOver: true, winner: playerIndex };
      }

      if (this._isBoardFull()) {
        this.gameOver = true;
        this.winner = null;
        return { gameOver: true, winner: null };
      }

      this.currentPlayer = 1 - playerIndex;
      this.turnStartTime = Date.now();
      return { gameOver: false };
    }

    return { error: 'Invalid action' };
  }

  autoPlayForTimeout(playerIndex) {
    const validCols = [];
    for (let c = 0; c < COLS; c++) {
      if (this.board[0][c] === null) validCols.push(c);
    }
    if (validCols.length === 0) return null;
    const col = validCols[Math.floor(Math.random() * validCols.length)];
    return this.handleAction(playerIndex, { type: 'drop', col });
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);
    return {
      gameType: 'connect4',
      board: this.board,
      rows: ROWS,
      cols: COLS,
      lastMove: this.lastMove,
      winLine: this.winLine,
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

module.exports = Connect4Game;
