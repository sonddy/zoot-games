const TURN_TIME_MS = 30000;
const SIZE = 7;

class HexGame {
  constructor() {
    this.board = [];
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
  }

  init(numPlayers, options = {}) {
    this.board = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
  }

  _checkWin(player) {
    const visited = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
    const queue = [];

    if (player === 0) {
      for (let r = 0; r < SIZE; r++) {
        if (this.board[r][0] === 0) { queue.push([r, 0]); visited[r][0] = true; }
      }
    } else {
      for (let c = 0; c < SIZE; c++) {
        if (this.board[0][c] === 1) { queue.push([0, c]); visited[0][c] = true; }
      }
    }

    const dirs = [[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0]];
    while (queue.length > 0) {
      const [r, c] = queue.shift();
      if (player === 0 && c === SIZE - 1) return true;
      if (player === 1 && r === SIZE - 1) return true;
      for (const [dr, dc] of dirs) {
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && !visited[nr][nc] && this.board[nr][nc] === player) {
          visited[nr][nc] = true;
          queue.push([nr, nc]);
        }
      }
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
      if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return { error: 'Invalid position' };
      if (this.board[row][col] !== null) return { error: 'Cell occupied' };

      this.board[row][col] = playerIndex;

      if (this._checkWin(playerIndex)) {
        this.gameOver = true;
        this.winner = playerIndex;
        return { gameOver: true, winner: playerIndex };
      }

      this.currentPlayer = 1 - playerIndex;
      this.turnStartTime = Date.now();
      return { gameOver: false };
    }

    return { error: 'Invalid action' };
  }

  autoPlayForTimeout(playerIndex) {
    const empty = [];
    for (let r = 0; r < SIZE; r++)
      for (let c = 0; c < SIZE; c++)
        if (this.board[r][c] === null) empty.push({ row: r, col: c });
    if (empty.length === 0) return null;
    const pick = empty[Math.floor(Math.random() * empty.length)];
    return this.handleAction(playerIndex, { type: 'place', ...pick });
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);
    return {
      gameType: 'hex',
      board: this.board,
      size: SIZE,
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

module.exports = HexGame;
