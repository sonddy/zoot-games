class TicTacToeGame {
  constructor() {
    this.size = 3;
    this.winLength = 3;
    this.board = [];
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
  }

  init(numPlayers, options = {}) {
    this.size = options.gridSize || 3;
    // 3x3 = 3 in a row, 5x5 = 4 in a row, 7x7 = 4 in a row
    this.winLength = this.size <= 3 ? 3 : 4;
    this.board = Array(this.size * this.size).fill(null);
    this.currentPlayer = Math.random() < 0.5 ? 0 : 1;
  }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };
    if (playerIndex !== this.currentPlayer) return { error: 'Not your turn' };
    if (action.type !== 'place') return { error: 'Invalid action' };

    const { cell } = action;
    const total = this.size * this.size;
    if (cell < 0 || cell >= total || this.board[cell] !== null) {
      return { error: 'Invalid cell' };
    }

    this.board[cell] = playerIndex;

    if (this._checkWin(playerIndex)) {
      this.gameOver = true;
      this.winner = playerIndex;
      return { gameOver: true, winner: playerIndex };
    }

    if (this.board.every(c => c !== null)) {
      this.gameOver = true;
      this.winner = null;
      return { gameOver: true, winner: null };
    }

    this.currentPlayer = 1 - this.currentPlayer;
    return { gameOver: false };
  }

  _checkWin(p) {
    const s = this.size;
    const w = this.winLength;
    const b = this.board;

    const directions = [
      [0, 1],  // horizontal
      [1, 0],  // vertical
      [1, 1],  // diagonal down-right
      [1, -1], // diagonal down-left
    ];

    for (let r = 0; r < s; r++) {
      for (let c = 0; c < s; c++) {
        if (b[r * s + c] !== p) continue;
        for (const [dr, dc] of directions) {
          let count = 1;
          for (let step = 1; step < w; step++) {
            const nr = r + dr * step;
            const nc = c + dc * step;
            if (nr < 0 || nr >= s || nc < 0 || nc >= s) break;
            if (b[nr * s + nc] !== p) break;
            count++;
          }
          if (count >= w) return true;
        }
      }
    }
    return false;
  }

  getStateForPlayer(playerIndex) {
    return {
      gameType: 'tictactoe',
      board: this.board,
      size: this.size,
      winLength: this.winLength,
      currentPlayer: this.currentPlayer,
      isMyTurn: this.currentPlayer === playerIndex,
      playerIndex,
      symbol: playerIndex === 0 ? 'X' : 'O',
      gameOver: this.gameOver,
      winner: this.winner,
    };
  }
}

module.exports = TicTacToeGame;
