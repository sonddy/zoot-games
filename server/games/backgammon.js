const TURN_TIME_MS = 30000;

class BackgammonGame {
  constructor() {
    this.points = [];
    this.bar = [0, 0];
    this.home = [0, 0];
    this.dice = [0, 0];
    this.movesLeft = [];
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
    this.diceRolled = false;
  }

  init(numPlayers, options = {}) {
    this.points = Array(24).fill(null).map(() => ({ player: null, count: 0 }));
    this._setPoint(0, 0, 2);
    this._setPoint(11, 0, 5);
    this._setPoint(16, 0, 3);
    this._setPoint(18, 0, 5);
    this._setPoint(23, 1, 2);
    this._setPoint(12, 1, 5);
    this._setPoint(7, 1, 3);
    this._setPoint(5, 1, 5);

    this.bar = [0, 0];
    this.home = [0, 0];
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.diceRolled = false;
    this.dice = [0, 0];
    this.movesLeft = [];
    this.turnStartTime = Date.now();
  }

  _setPoint(idx, player, count) {
    this.points[idx] = { player, count };
  }

  _rollDice() {
    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    this.dice = [d1, d2];
    this.movesLeft = d1 === d2 ? [d1, d1, d1, d1] : [d1, d2];
    this.diceRolled = true;
  }

  _canBearOff(player) {
    if (this.bar[player] > 0) return false;
    const homeStart = player === 0 ? 18 : 0;
    const homeEnd = player === 0 ? 23 : 5;
    for (let i = 0; i < 24; i++) {
      if (this.points[i].player === player && this.points[i].count > 0) {
        if (player === 0 && i < homeStart) return false;
        if (player === 1 && i > homeEnd) return false;
      }
    }
    return true;
  }

  _getValidMoves(player) {
    const moves = [];

    if (this.bar[player] > 0) {
      for (const die of [...new Set(this.movesLeft)]) {
        const target = player === 0 ? die - 1 : 24 - die;
        if (target < 0 || target >= 24) continue;
        const pt = this.points[target];
        if (pt.player === null || pt.player === player || pt.count <= 1) {
          moves.push({ from: 'bar', to: target, die });
        }
      }
      return moves;
    }

    const canBearOff = this._canBearOff(player);

    for (let i = 0; i < 24; i++) {
      if (this.points[i].player !== player || this.points[i].count === 0) continue;

      for (const die of [...new Set(this.movesLeft)]) {
        const target = player === 0 ? i + die : i - die;

        if (canBearOff) {
          if ((player === 0 && target >= 24) || (player === 1 && target < 0)) {
            if (player === 0) {
              const exactDist = 24 - i;
              if (die === exactDist) {
                moves.push({ from: i, to: 'home', die });
              } else if (die > exactDist) {
                let hasHigher = false;
                for (let j = 18; j < i; j++) {
                  if (this.points[j].player === player && this.points[j].count > 0) hasHigher = true;
                }
                if (!hasHigher) moves.push({ from: i, to: 'home', die });
              }
            } else {
              const exactDist = i + 1;
              if (die === exactDist) {
                moves.push({ from: i, to: 'home', die });
              } else if (die > exactDist) {
                let hasHigher = false;
                for (let j = i + 1; j <= 5; j++) {
                  if (this.points[j].player === player && this.points[j].count > 0) hasHigher = true;
                }
                if (!hasHigher) moves.push({ from: i, to: 'home', die });
              }
            }
            continue;
          }
        }

        if (target < 0 || target >= 24) continue;
        const pt = this.points[target];
        if (pt.player === null || pt.player === player || pt.count <= 1) {
          moves.push({ from: i, to: target, die });
        }
      }
    }

    return moves;
  }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };
    if (action.type === 'resign') {
      this.gameOver = true;
      this.winner = 1 - playerIndex;
      return { gameOver: true, winner: this.winner, resigned: true };
    }
    if (playerIndex !== this.currentPlayer) return { error: 'Not your turn' };

    if (action.type === 'roll') {
      if (this.diceRolled) return { error: 'Already rolled' };
      this._rollDice();
      const moves = this._getValidMoves(playerIndex);
      if (moves.length === 0) {
        this.movesLeft = [];
        this.diceRolled = false;
        this.currentPlayer = 1 - playerIndex;
        this.turnStartTime = Date.now();
        return { gameOver: false, noMoves: true };
      }
      this.turnStartTime = Date.now();
      return { gameOver: false, rolled: true };
    }

    if (action.type === 'move') {
      if (!this.diceRolled) return { error: 'Roll dice first' };
      const { from, to, die } = action;

      const dieIdx = this.movesLeft.indexOf(die);
      if (dieIdx === -1) return { error: 'Invalid die value' };

      if (from === 'bar') {
        if (this.bar[playerIndex] === 0) return { error: 'No pieces on bar' };
        const target = typeof to === 'number' ? to : -1;
        if (target < 0 || target >= 24) return { error: 'Invalid target' };
        const pt = this.points[target];

        if (pt.player !== null && pt.player !== playerIndex && pt.count > 1) {
          return { error: 'Point is blocked' };
        }

        if (pt.player !== null && pt.player !== playerIndex && pt.count === 1) {
          this.bar[1 - playerIndex]++;
          pt.count = 0;
          pt.player = null;
        }

        this.bar[playerIndex]--;
        pt.player = playerIndex;
        pt.count++;
      } else if (to === 'home') {
        if (!this._canBearOff(playerIndex)) return { error: 'Cannot bear off yet' };
        const fromIdx = typeof from === 'number' ? from : -1;
        if (fromIdx < 0 || fromIdx >= 24) return { error: 'Invalid source' };
        if (this.points[fromIdx].player !== playerIndex || this.points[fromIdx].count === 0) {
          return { error: 'No piece there' };
        }
        this.points[fromIdx].count--;
        if (this.points[fromIdx].count === 0) this.points[fromIdx].player = null;
        this.home[playerIndex]++;
      } else {
        const fromIdx = typeof from === 'number' ? from : -1;
        const toIdx = typeof to === 'number' ? to : -1;
        if (fromIdx < 0 || fromIdx >= 24 || toIdx < 0 || toIdx >= 24) {
          return { error: 'Invalid move' };
        }
        if (this.points[fromIdx].player !== playerIndex || this.points[fromIdx].count === 0) {
          return { error: 'No piece there' };
        }
        const pt = this.points[toIdx];
        if (pt.player !== null && pt.player !== playerIndex && pt.count > 1) {
          return { error: 'Point is blocked' };
        }

        if (pt.player !== null && pt.player !== playerIndex && pt.count === 1) {
          this.bar[1 - playerIndex]++;
          pt.count = 0;
          pt.player = null;
        }

        this.points[fromIdx].count--;
        if (this.points[fromIdx].count === 0) this.points[fromIdx].player = null;
        pt.player = playerIndex;
        pt.count++;
      }

      this.movesLeft.splice(dieIdx, 1);

      if (this.home[playerIndex] >= 15) {
        this.gameOver = true;
        this.winner = playerIndex;
        return { gameOver: true, winner: playerIndex };
      }

      if (this.movesLeft.length === 0 || this._getValidMoves(playerIndex).length === 0) {
        this.movesLeft = [];
        this.diceRolled = false;
        this.currentPlayer = 1 - playerIndex;
        this.turnStartTime = Date.now();
      }

      return { gameOver: false };
    }

    return { error: 'Invalid action' };
  }

  autoPlayForTimeout(playerIndex) {
    if (!this.diceRolled) {
      return this.handleAction(playerIndex, { type: 'roll' });
    }
    const moves = this._getValidMoves(playerIndex);
    if (moves.length === 0) {
      this.movesLeft = [];
      this.diceRolled = false;
      this.currentPlayer = 1 - playerIndex;
      this.turnStartTime = Date.now();
      return { gameOver: false };
    }
    const move = moves[Math.floor(Math.random() * moves.length)];
    const result = this.handleAction(playerIndex, { type: 'move', from: move.from, to: move.to, die: move.die });
    if (result.error) {
      this.movesLeft = [];
      this.diceRolled = false;
      this.currentPlayer = 1 - playerIndex;
      this.turnStartTime = Date.now();
      return { gameOver: false };
    }
    return result;
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);
    const validMoves = (playerIndex === this.currentPlayer && this.diceRolled)
      ? this._getValidMoves(playerIndex) : [];

    return {
      gameType: 'backgammon',
      points: this.points,
      bar: this.bar,
      home: this.home,
      dice: this.diceRolled ? this.dice : null,
      movesLeft: this.movesLeft,
      validMoves,
      diceRolled: this.diceRolled,
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

module.exports = BackgammonGame;
