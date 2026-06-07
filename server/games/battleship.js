const TURN_TIME_MS = 40000;
const SIZE = 10;
const SHIPS = [
  { name: 'Carrier', size: 5 },
  { name: 'Battleship', size: 4 },
  { name: 'Cruiser', size: 3 },
  { name: 'Submarine', size: 3 },
  { name: 'Destroyer', size: 2 },
];

class BattleshipGame {
  constructor() {
    this.boards = [null, null];
    this.shots = [null, null];
    this.ships = [null, null];
    this.phase = 'setup';
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
    this.ready = [false, false];
  }

  init(numPlayers, options = {}) {
    this.boards = [
      Array.from({ length: SIZE }, () => Array(SIZE).fill(null)),
      Array.from({ length: SIZE }, () => Array(SIZE).fill(null)),
    ];
    this.shots = [
      Array.from({ length: SIZE }, () => Array(SIZE).fill(false)),
      Array.from({ length: SIZE }, () => Array(SIZE).fill(false)),
    ];
    this.ships = [[], []];
    this.phase = 'setup';
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.ready = [false, false];
    this.turnStartTime = Date.now();

    for (let p = 0; p < 2; p++) this._autoPlaceShips(p);
    this.ready = [true, true];
    this.phase = 'battle';
  }

  _autoPlaceShips(playerIndex) {
    const board = this.boards[playerIndex];
    const placed = [];

    for (const ship of SHIPS) {
      let attempts = 0;
      while (attempts < 200) {
        const horizontal = Math.random() < 0.5;
        const r = Math.floor(Math.random() * SIZE);
        const c = Math.floor(Math.random() * SIZE);
        const cells = [];
        let valid = true;

        for (let i = 0; i < ship.size; i++) {
          const nr = horizontal ? r : r + i;
          const nc = horizontal ? c + i : c;
          if (nr >= SIZE || nc >= SIZE || board[nr][nc] !== null) { valid = false; break; }
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              const ar = nr + dr, ac = nc + dc;
              if (ar >= 0 && ar < SIZE && ac >= 0 && ac < SIZE && board[ar][ac] !== null) {
                valid = false; break;
              }
            }
            if (!valid) break;
          }
          if (!valid) break;
          cells.push([nr, nc]);
        }

        if (valid && cells.length === ship.size) {
          for (const [cr, cc] of cells) board[cr][cc] = placed.length;
          placed.push({ name: ship.name, size: ship.size, cells, hits: 0, sunk: false });
          break;
        }
        attempts++;
      }
    }
    this.ships[playerIndex] = placed;
  }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };
    if (action.type === 'resign') {
      this.gameOver = true;
      this.winner = 1 - playerIndex;
      return { gameOver: true, winner: this.winner, resigned: true };
    }

    if (this.phase !== 'battle') return { error: 'Game not started yet' };
    if (playerIndex !== this.currentPlayer) return { error: 'Not your turn' };

    if (action.type === 'fire') {
      const { row, col } = action;
      if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return { error: 'Invalid target' };

      const target = 1 - playerIndex;
      if (this.shots[playerIndex][row][col]) return { error: 'Already fired there' };

      this.shots[playerIndex][row][col] = true;
      const cellVal = this.boards[target][row][col];
      let hit = false;
      let sunkShip = null;

      if (cellVal !== null) {
        hit = true;
        const ship = this.ships[target][cellVal];
        ship.hits++;
        if (ship.hits >= ship.size) {
          ship.sunk = true;
          sunkShip = ship.name;
        }
      }

      const allSunk = this.ships[target].every(s => s.sunk);
      if (allSunk) {
        this.gameOver = true;
        this.winner = playerIndex;
        return { gameOver: true, winner: playerIndex, hit, sunkShip };
      }

      this.currentPlayer = target;
      this.turnStartTime = Date.now();
      return { gameOver: false, hit, sunkShip };
    }

    return { error: 'Invalid action' };
  }

  autoPlayForTimeout(playerIndex) {
    const target = 1 - playerIndex;
    const available = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (!this.shots[playerIndex][r][c]) available.push({ row: r, col: c });
      }
    }
    if (available.length === 0) return null;
    const pick = available[Math.floor(Math.random() * available.length)];
    return this.handleAction(playerIndex, { type: 'fire', row: pick.row, col: pick.col });
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);
    const opp = 1 - playerIndex;

    const myBoard = this.boards[playerIndex].map((row, r) =>
      row.map((cell, c) => {
        const shot = this.shots[opp][r][c];
        return { ship: cell !== null, hit: shot && cell !== null, miss: shot && cell === null };
      })
    );

    const oppBoard = this.boards[opp].map((row, r) =>
      row.map((cell, c) => {
        const shot = this.shots[playerIndex][r][c];
        if (!shot) return { unknown: true };
        return { hit: cell !== null, miss: cell === null };
      })
    );

    const mySunkCount = this.ships[playerIndex].filter(s => s.sunk).length;
    const oppSunkCount = this.ships[opp].filter(s => s.sunk).length;
    const oppSunkNames = this.ships[opp].filter(s => s.sunk).map(s => s.name);

    return {
      gameType: 'battleship',
      myBoard,
      oppBoard,
      size: SIZE,
      myShips: this.ships[playerIndex].map(s => ({ name: s.name, size: s.size, sunk: s.sunk })),
      mySunkCount,
      oppSunkCount,
      oppSunkNames,
      totalShips: SHIPS.length,
      phase: this.phase,
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

module.exports = BattleshipGame;
