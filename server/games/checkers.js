const TURN_TIME_MS = 30000;

class CheckersGame {
  constructor() {
    this.board = [];
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
    this.mustJumpFrom = null;
  }

  init(numPlayers, options = {}) {
    this.board = Array(64).fill(null);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 8; c++) {
        if ((r + c) % 2 === 1) this.board[r * 8 + c] = { player: 1, king: false };
      }
    }
    for (let r = 5; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if ((r + c) % 2 === 1) this.board[r * 8 + c] = { player: 0, king: false };
      }
    }
    this.currentPlayer = 0;
    this.turnStartTime = Date.now();
    this.mustJumpFrom = null;
  }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };
    if (action.type === 'resign') {
      this.gameOver = true;
      this.winner = 1 - playerIndex;
      return { gameOver: true, winner: this.winner, resigned: true };
    }
    if (playerIndex !== this.currentPlayer) return { error: 'Not your turn' };
    if (action.type !== 'move') return { error: 'Invalid action' };

    const { from, to } = action;
    if (from < 0 || from > 63 || to < 0 || to > 63) return { error: 'Invalid square' };

    const piece = this.board[from];
    if (!piece || piece.player !== playerIndex) return { error: 'Not your piece' };

    if (this.mustJumpFrom !== null && from !== this.mustJumpFrom) {
      return { error: 'Must continue jumping with the same piece' };
    }

    const fr = Math.floor(from / 8), fc = from % 8;
    const tr = Math.floor(to / 8), tc = to % 8;

    const jumps = this._getJumps(from, piece);
    const hasAnyJumps = this.mustJumpFrom !== null || this._playerHasJumps(playerIndex);

    if (hasAnyJumps) {
      const jump = jumps.find(j => j.to === to);
      if (!jump) return { error: 'Must capture when possible' };

      this.board[to] = piece;
      this.board[from] = null;
      this.board[jump.captured] = null;

      if (this._shouldKing(to, playerIndex)) piece.king = true;

      const moreJumps = this._getJumps(to, piece);
      if (moreJumps.length > 0) {
        this.mustJumpFrom = to;
        this.turnStartTime = Date.now();
        return { gameOver: false, multiJump: true };
      }

      this.mustJumpFrom = null;
      return this._endTurn();
    }

    const dr = tr - fr, dc = tc - fc;
    if (Math.abs(dr) !== 1 || Math.abs(dc) !== 1) return { error: 'Invalid move' };
    if (!piece.king) {
      if (playerIndex === 0 && dr >= 0) return { error: 'Must move forward' };
      if (playerIndex === 1 && dr <= 0) return { error: 'Must move forward' };
    }
    if (this.board[to] !== null) return { error: 'Square occupied' };

    this.board[to] = piece;
    this.board[from] = null;
    if (this._shouldKing(to, playerIndex)) piece.king = true;

    this.mustJumpFrom = null;
    return this._endTurn();
  }

  _shouldKing(pos, player) {
    const r = Math.floor(pos / 8);
    return (player === 0 && r === 0) || (player === 1 && r === 7);
  }

  _getJumps(pos, piece) {
    const r = Math.floor(pos / 8), c = pos % 8;
    const jumps = [];
    const dirs = piece.king
      ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
      : piece.player === 0
        ? [[-1, -1], [-1, 1]]
        : [[1, -1], [1, 1]];

    for (const [dr, dc] of dirs) {
      const mr = r + dr, mc = c + dc;
      const lr = r + 2 * dr, lc = c + 2 * dc;
      if (lr < 0 || lr > 7 || lc < 0 || lc > 7) continue;
      const mid = this.board[mr * 8 + mc];
      const land = this.board[lr * 8 + lc];
      if (mid && mid.player !== piece.player && land === null) {
        jumps.push({ to: lr * 8 + lc, captured: mr * 8 + mc });
      }
    }
    return jumps;
  }

  _playerHasJumps(player) {
    for (let i = 0; i < 64; i++) {
      const p = this.board[i];
      if (p && p.player === player && this._getJumps(i, p).length > 0) return true;
    }
    return false;
  }

  _getMoves(pos, piece) {
    const r = Math.floor(pos / 8), c = pos % 8;
    const moves = [];
    const dirs = piece.king
      ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
      : piece.player === 0
        ? [[-1, -1], [-1, 1]]
        : [[1, -1], [1, 1]];

    for (const [dr, dc] of dirs) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr > 7 || nc < 0 || nc > 7) continue;
      if (this.board[nr * 8 + nc] === null) moves.push(nr * 8 + nc);
    }
    return moves;
  }

  _playerHasMoves(player) {
    for (let i = 0; i < 64; i++) {
      const p = this.board[i];
      if (p && p.player === player) {
        if (this._getJumps(i, p).length > 0 || this._getMoves(i, p).length > 0) return true;
      }
    }
    return false;
  }

  _countPieces(player) {
    let c = 0;
    for (let i = 0; i < 64; i++) { if (this.board[i] && this.board[i].player === player) c++; }
    return c;
  }

  _endTurn() {
    this.currentPlayer = 1 - this.currentPlayer;
    this.turnStartTime = Date.now();

    if (!this._playerHasMoves(this.currentPlayer)) {
      this.gameOver = true;
      this.winner = 1 - this.currentPlayer;
      return { gameOver: true, winner: this.winner };
    }
    if (this._countPieces(this.currentPlayer) === 0) {
      this.gameOver = true;
      this.winner = 1 - this.currentPlayer;
      return { gameOver: true, winner: this.winner };
    }
    return { gameOver: false };
  }

  autoPlayForTimeout(playerIndex) {
    if (this.mustJumpFrom !== null) {
      const piece = this.board[this.mustJumpFrom];
      if (piece) {
        const jumps = this._getJumps(this.mustJumpFrom, piece);
        if (jumps.length > 0) {
          return this.handleAction(playerIndex, { type: 'move', from: this.mustJumpFrom, to: jumps[0].to });
        }
      }
    }
    for (let i = 0; i < 64; i++) {
      const p = this.board[i];
      if (p && p.player === playerIndex) {
        const jumps = this._getJumps(i, p);
        if (jumps.length > 0) return this.handleAction(playerIndex, { type: 'move', from: i, to: jumps[0].to });
      }
    }
    for (let i = 0; i < 64; i++) {
      const p = this.board[i];
      if (p && p.player === playerIndex) {
        const moves = this._getMoves(i, p);
        if (moves.length > 0) return this.handleAction(playerIndex, { type: 'move', from: i, to: moves[0] });
      }
    }
    return null;
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);
    const boardView = this.board.map(sq => sq ? { player: sq.player, king: sq.king } : null);
    return {
      gameType: 'checkers',
      board: boardView,
      currentPlayer: this.currentPlayer,
      isMyTurn: !this.gameOver && this.currentPlayer === playerIndex,
      playerIndex,
      pieces: [this._countPieces(0), this._countPieces(1)],
      mustJumpFrom: this.mustJumpFrom,
      gameOver: this.gameOver,
      winner: this.winner,
      turnTimeMs: TURN_TIME_MS,
      turnRemainingMs: remaining,
    };
  }
}

module.exports = CheckersGame;
