const TURN_TIME_MS = 30000;

class ReversiGame {
  constructor() {
    this.board = [];
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
    this.passed = [false, false];
  }

  init(numPlayers, options = {}) {
    this.board = Array.from({ length: 8 }, () => Array(8).fill(null));
    this.board[3][3] = 1;
    this.board[3][4] = 0;
    this.board[4][3] = 0;
    this.board[4][4] = 1;
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.passed = [false, false];
    this.turnStartTime = Date.now();
  }

  _directions() {
    return [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  }

  _getFlips(row, col, player) {
    if (this.board[row][col] !== null) return [];
    const opp = 1 - player;
    const allFlips = [];
    for (const [dr, dc] of this._directions()) {
      const flips = [];
      let r = row + dr, c = col + dc;
      while (r >= 0 && r < 8 && c >= 0 && c < 8 && this.board[r][c] === opp) {
        flips.push([r, c]);
        r += dr;
        c += dc;
      }
      if (flips.length > 0 && r >= 0 && r < 8 && c >= 0 && c < 8 && this.board[r][c] === player) {
        allFlips.push(...flips);
      }
    }
    return allFlips;
  }

  _getValidMoves(player) {
    const moves = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (this._getFlips(r, c, player).length > 0) {
          moves.push({ row: r, col: c });
        }
      }
    }
    return moves;
  }

  _countPieces() {
    let c0 = 0, c1 = 0;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (this.board[r][c] === 0) c0++;
        else if (this.board[r][c] === 1) c1++;
      }
    }
    return [c0, c1];
  }

  _checkGameEnd() {
    if (this.passed[0] && this.passed[1]) {
      this.gameOver = true;
      const [c0, c1] = this._countPieces();
      if (c0 > c1) this.winner = 0;
      else if (c1 > c0) this.winner = 1;
      else this.winner = null;
      return true;
    }
    let totalPieces = 0;
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++)
        if (this.board[r][c] !== null) totalPieces++;
    if (totalPieces === 64) {
      this.gameOver = true;
      const [c0, c1] = this._countPieces();
      if (c0 > c1) this.winner = 0;
      else if (c1 > c0) this.winner = 1;
      else this.winner = null;
      return true;
    }
    return false;
  }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };
    if (action.type === 'resign') {
      this.gameOver = true;
      this.winner = 1 - playerIndex;
      return { gameOver: true, winner: this.winner, resigned: true };
    }
    if (playerIndex !== this.currentPlayer) return { error: 'Not your turn' };

    if (action.type === 'place') {
      const { row, col } = action;
      if (row < 0 || row >= 8 || col < 0 || col >= 8) return { error: 'Invalid position' };

      const flips = this._getFlips(row, col, playerIndex);
      if (flips.length === 0) return { error: 'Invalid move' };

      this.board[row][col] = playerIndex;
      for (const [fr, fc] of flips) this.board[fr][fc] = playerIndex;
      this.passed[playerIndex] = false;

      this.currentPlayer = 1 - playerIndex;
      const nextMoves = this._getValidMoves(this.currentPlayer);
      if (nextMoves.length === 0) {
        this.passed[this.currentPlayer] = true;
        this.currentPlayer = playerIndex;
        const myMoves = this._getValidMoves(this.currentPlayer);
        if (myMoves.length === 0) {
          this.passed[this.currentPlayer] = true;
        }
      }

      if (this._checkGameEnd()) {
        return { gameOver: true, winner: this.winner };
      }

      this.turnStartTime = Date.now();
      return { gameOver: false };
    }

    return { error: 'Invalid action' };
  }

  autoPlayForTimeout(playerIndex) {
    const moves = this._getValidMoves(playerIndex);
    if (moves.length === 0) {
      this.passed[playerIndex] = true;
      this.currentPlayer = 1 - playerIndex;
      if (this._checkGameEnd()) {
        return { gameOver: true, winner: this.winner };
      }
      this.turnStartTime = Date.now();
      return { gameOver: false };
    }
    const move = moves[Math.floor(Math.random() * moves.length)];
    return this.handleAction(playerIndex, { type: 'place', row: move.row, col: move.col });
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);
    const validMoves = playerIndex === this.currentPlayer ? this._getValidMoves(playerIndex) : [];
    const [c0, c1] = this._countPieces();

    return {
      gameType: 'reversi',
      board: this.board,
      validMoves,
      myCount: playerIndex === 0 ? c0 : c1,
      oppCount: playerIndex === 0 ? c1 : c0,
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

module.exports = ReversiGame;
