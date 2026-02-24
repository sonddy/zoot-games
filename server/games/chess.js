const TURN_TIME_MS = 60000;

const PIECES = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };

class ChessGame {
  constructor() {
    this.board = [];
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
    this.castlingRights = { 0: { kingSide: true, queenSide: true }, 1: { kingSide: true, queenSide: true } };
    this.enPassant = null;
    this.halfMoveClock = 0;
    this.moveHistory = [];
    this.inCheck = false;
  }

  init(numPlayers, options = {}) {
    this.board = Array(64).fill(null);
    const backRank = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R'];
    for (let c = 0; c < 8; c++) {
      this.board[c] = { type: backRank[c], player: 1 };
      this.board[8 + c] = { type: 'P', player: 1 };
      this.board[48 + c] = { type: 'P', player: 0 };
      this.board[56 + c] = { type: backRank[c], player: 0 };
    }
    this.currentPlayer = 0;
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
    if (action.type !== 'move') return { error: 'Invalid action' };

    const { from, to, promotion } = action;
    if (from < 0 || from > 63 || to < 0 || to > 63) return { error: 'Invalid square' };

    const piece = this.board[from];
    if (!piece || piece.player !== playerIndex) return { error: 'Not your piece' };

    const legalMoves = this._getLegalMoves(from);
    if (!legalMoves.includes(to)) return { error: 'Illegal move' };

    this._makeMove(from, to, promotion);
    this.currentPlayer = 1 - this.currentPlayer;
    this.turnStartTime = Date.now();
    this.inCheck = this._isInCheck(this.currentPlayer);

    if (!this._hasLegalMoves(this.currentPlayer)) {
      this.gameOver = true;
      this.winner = this.inCheck ? playerIndex : null;
      return { gameOver: true, winner: this.winner, checkmate: this.inCheck, stalemate: !this.inCheck };
    }

    return { gameOver: false, check: this.inCheck };
  }

  _makeMove(from, to, promotion) {
    const piece = this.board[from];
    const captured = this.board[to];
    const fr = Math.floor(from / 8), fc = from % 8;
    const tr = Math.floor(to / 8), tc = to % 8;

    if (piece.type === 'P' || captured) this.halfMoveClock = 0;
    else this.halfMoveClock++;

    if (piece.type === 'P' && to === this.enPassant) {
      const epR = piece.player === 0 ? tr + 1 : tr - 1;
      this.board[epR * 8 + tc] = null;
    }
    this.enPassant = null;

    if (piece.type === 'P' && Math.abs(fr - tr) === 2) {
      this.enPassant = ((fr + tr) / 2) * 8 + fc;
    }

    if (piece.type === 'K') {
      this.castlingRights[piece.player].kingSide = false;
      this.castlingRights[piece.player].queenSide = false;
      if (Math.abs(fc - tc) === 2) {
        if (tc === 6) {
          this.board[fr * 8 + 5] = this.board[fr * 8 + 7];
          this.board[fr * 8 + 7] = null;
        } else if (tc === 2) {
          this.board[fr * 8 + 3] = this.board[fr * 8 + 0];
          this.board[fr * 8 + 0] = null;
        }
      }
    }

    if (piece.type === 'R') {
      if (fc === 0) this.castlingRights[piece.player].queenSide = false;
      if (fc === 7) this.castlingRights[piece.player].kingSide = false;
    }
    if (captured && captured.type === 'R') {
      if (tc === 0) this.castlingRights[captured.player].queenSide = false;
      if (tc === 7) this.castlingRights[captured.player].kingSide = false;
    }

    this.board[to] = piece;
    this.board[from] = null;

    if (piece.type === 'P') {
      const promRank = piece.player === 0 ? 0 : 7;
      if (tr === promRank) {
        piece.type = promotion && ['Q', 'R', 'B', 'N'].includes(promotion) ? promotion : 'Q';
      }
    }

    this.moveHistory.push({ from, to, piece: piece.type, player: piece.player });
  }

  _findKing(player) {
    for (let i = 0; i < 64; i++) {
      if (this.board[i] && this.board[i].player === player && this.board[i].type === 'K') return i;
    }
    return -1;
  }

  _isSquareAttacked(sq, byPlayer) {
    for (let i = 0; i < 64; i++) {
      const p = this.board[i];
      if (!p || p.player !== byPlayer) continue;
      if (this._rawMoves(i, p).includes(sq)) return true;
    }
    return false;
  }

  _isInCheck(player) {
    const kingPos = this._findKing(player);
    return this._isSquareAttacked(kingPos, 1 - player);
  }

  _rawMoves(pos, piece) {
    const r = Math.floor(pos / 8), c = pos % 8;
    const moves = [];

    const addSlide = (dirs) => {
      for (const [dr, dc] of dirs) {
        for (let s = 1; s < 8; s++) {
          const nr = r + dr * s, nc = c + dc * s;
          if (nr < 0 || nr > 7 || nc < 0 || nc > 7) break;
          const tgt = this.board[nr * 8 + nc];
          if (tgt) {
            if (tgt.player !== piece.player) moves.push(nr * 8 + nc);
            break;
          }
          moves.push(nr * 8 + nc);
        }
      }
    };

    switch (piece.type) {
      case 'P': {
        const dir = piece.player === 0 ? -1 : 1;
        const startRow = piece.player === 0 ? 6 : 1;
        const nr = r + dir;
        if (nr >= 0 && nr <= 7 && !this.board[nr * 8 + c]) {
          moves.push(nr * 8 + c);
          if (r === startRow && !this.board[(r + 2 * dir) * 8 + c]) moves.push((r + 2 * dir) * 8 + c);
        }
        for (const dc of [-1, 1]) {
          const nc = c + dc;
          if (nc < 0 || nc > 7 || nr < 0 || nr > 7) continue;
          const tgt = this.board[nr * 8 + nc];
          if (tgt && tgt.player !== piece.player) moves.push(nr * 8 + nc);
          if (this.enPassant === nr * 8 + nc) moves.push(nr * 8 + nc);
        }
        break;
      }
      case 'N': {
        for (const [dr, dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr > 7 || nc < 0 || nc > 7) continue;
          const tgt = this.board[nr * 8 + nc];
          if (!tgt || tgt.player !== piece.player) moves.push(nr * 8 + nc);
        }
        break;
      }
      case 'B': addSlide([[-1,-1],[-1,1],[1,-1],[1,1]]); break;
      case 'R': addSlide([[-1,0],[1,0],[0,-1],[0,1]]); break;
      case 'Q': addSlide([[-1,-1],[-1,1],[1,-1],[1,1],[-1,0],[1,0],[0,-1],[0,1]]); break;
      case 'K': {
        for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr > 7 || nc < 0 || nc > 7) continue;
          const tgt = this.board[nr * 8 + nc];
          if (!tgt || tgt.player !== piece.player) moves.push(nr * 8 + nc);
        }
        break;
      }
    }
    return moves;
  }

  _getLegalMoves(pos) {
    const piece = this.board[pos];
    if (!piece) return [];
    const raw = this._rawMoves(pos, piece);
    const legal = [];

    for (const to of raw) {
      const saved = this.board[to];
      const savedEp = this.enPassant;
      let epCapture = null;

      if (piece.type === 'P' && to === this.enPassant) {
        const tr = Math.floor(to / 8), tc = to % 8;
        const epR = piece.player === 0 ? tr + 1 : tr - 1;
        epCapture = epR * 8 + tc;
        var epSaved = this.board[epCapture];
        this.board[epCapture] = null;
      }

      this.board[to] = piece;
      this.board[pos] = null;
      if (!this._isInCheck(piece.player)) legal.push(to);
      this.board[pos] = piece;
      this.board[to] = saved;
      this.enPassant = savedEp;

      if (epCapture !== null) this.board[epCapture] = epSaved;
    }

    if (piece.type === 'K') {
      const r = Math.floor(pos / 8);
      const cr = this.castlingRights[piece.player];
      if (cr.kingSide && !this.board[r * 8 + 5] && !this.board[r * 8 + 6]) {
        const rook = this.board[r * 8 + 7];
        if (rook && rook.type === 'R' && rook.player === piece.player) {
          if (!this._isInCheck(piece.player) &&
              !this._isSquareAttacked(r * 8 + 5, 1 - piece.player) &&
              !this._isSquareAttacked(r * 8 + 6, 1 - piece.player)) {
            legal.push(r * 8 + 6);
          }
        }
      }
      if (cr.queenSide && !this.board[r * 8 + 1] && !this.board[r * 8 + 2] && !this.board[r * 8 + 3]) {
        const rook = this.board[r * 8 + 0];
        if (rook && rook.type === 'R' && rook.player === piece.player) {
          if (!this._isInCheck(piece.player) &&
              !this._isSquareAttacked(r * 8 + 2, 1 - piece.player) &&
              !this._isSquareAttacked(r * 8 + 3, 1 - piece.player)) {
            legal.push(r * 8 + 2);
          }
        }
      }
    }

    return legal;
  }

  _hasLegalMoves(player) {
    for (let i = 0; i < 64; i++) {
      if (this.board[i] && this.board[i].player === player && this._getLegalMoves(i).length > 0) return true;
    }
    return false;
  }

  autoPlayForTimeout(playerIndex) {
    for (let i = 0; i < 64; i++) {
      const p = this.board[i];
      if (p && p.player === playerIndex) {
        const moves = this._getLegalMoves(i);
        if (moves.length > 0) return this.handleAction(playerIndex, { type: 'move', from: i, to: moves[0] });
      }
    }
    return null;
  }

  _countMaterial(player) {
    const vals = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
    let total = 0;
    for (let i = 0; i < 64; i++) {
      if (this.board[i] && this.board[i].player === player) total += vals[this.board[i].type];
    }
    return total;
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);
    const boardView = this.board.map(sq => sq ? { type: sq.type, player: sq.player } : null);
    return {
      gameType: 'chess',
      board: boardView,
      currentPlayer: this.currentPlayer,
      isMyTurn: !this.gameOver && this.currentPlayer === playerIndex,
      playerIndex,
      material: [this._countMaterial(0), this._countMaterial(1)],
      inCheck: this.inCheck,
      gameOver: this.gameOver,
      winner: this.winner,
      turnTimeMs: TURN_TIME_MS,
      turnRemainingMs: remaining,
      lastMove: this.moveHistory.length > 0 ? this.moveHistory[this.moveHistory.length - 1] : null,
    };
  }
}

module.exports = ChessGame;
