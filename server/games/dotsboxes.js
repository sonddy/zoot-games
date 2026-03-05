const TURN_TIME_MS = 20000;

class DotsBoxesGame {
  constructor() {
    this.rows = 4;
    this.cols = 4;
    this.hLines = [];
    this.vLines = [];
    this.boxes = [];
    this.currentPlayer = 0;
    this.scores = [0, 0];
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
    this.lastMove = null;
  }

  init(numPlayers, options = {}) {
    this.rows = 4;
    this.cols = 4;
    this.hLines = Array.from({ length: this.rows + 1 }, () => Array(this.cols).fill(null));
    this.vLines = Array.from({ length: this.rows }, () => Array(this.cols + 1).fill(null));
    this.boxes = Array.from({ length: this.rows }, () => Array(this.cols).fill(null));
    this.currentPlayer = 0;
    this.scores = [0, 0];
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

    if (action.type === 'line') {
      const { orientation, row, col } = action;
      if (orientation === 'h') {
        if (row < 0 || row > this.rows || col < 0 || col >= this.cols) return { error: 'Invalid line' };
        if (this.hLines[row][col] !== null) return { error: 'Line already drawn' };
        this.hLines[row][col] = playerIndex;
      } else if (orientation === 'v') {
        if (row < 0 || row >= this.rows || col < 0 || col > this.cols) return { error: 'Invalid line' };
        if (this.vLines[row][col] !== null) return { error: 'Line already drawn' };
        this.vLines[row][col] = playerIndex;
      } else {
        return { error: 'Invalid orientation' };
      }

      this.lastMove = { orientation, row, col };
      let boxesMade = 0;

      for (let r = 0; r < this.rows; r++) {
        for (let c = 0; c < this.cols; c++) {
          if (this.boxes[r][c] === null &&
              this.hLines[r][c] !== null && this.hLines[r + 1][c] !== null &&
              this.vLines[r][c] !== null && this.vLines[r][c + 1] !== null) {
            this.boxes[r][c] = playerIndex;
            this.scores[playerIndex]++;
            boxesMade++;
          }
        }
      }

      const totalBoxes = this.rows * this.cols;
      if (this.scores[0] + this.scores[1] >= totalBoxes) {
        this.gameOver = true;
        if (this.scores[0] > this.scores[1]) this.winner = 0;
        else if (this.scores[1] > this.scores[0]) this.winner = 1;
        else this.winner = null;
        return { gameOver: true, winner: this.winner };
      }

      if (boxesMade === 0) this.currentPlayer = 1 - playerIndex;
      this.turnStartTime = Date.now();
      return { gameOver: false };
    }

    return { error: 'Invalid action' };
  }

  autoPlayForTimeout(playerIndex) {
    const moves = [];
    for (let r = 0; r <= this.rows; r++)
      for (let c = 0; c < this.cols; c++)
        if (this.hLines[r][c] === null) moves.push({ orientation: 'h', row: r, col: c });
    for (let r = 0; r < this.rows; r++)
      for (let c = 0; c <= this.cols; c++)
        if (this.vLines[r][c] === null) moves.push({ orientation: 'v', row: r, col: c });
    if (moves.length === 0) return null;
    const move = moves[Math.floor(Math.random() * moves.length)];
    return this.handleAction(playerIndex, { type: 'line', ...move });
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);
    return {
      gameType: 'dotsboxes',
      rows: this.rows,
      cols: this.cols,
      hLines: this.hLines,
      vLines: this.vLines,
      boxes: this.boxes,
      scores: this.scores,
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

module.exports = DotsBoxesGame;
