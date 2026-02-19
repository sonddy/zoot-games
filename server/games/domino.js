// Full double-six domino game engine (1v1)
// Rules: each player gets 7 tiles, highest double starts, match ends on chain,
// if you can't play you draw from the boneyard until you can (or it's empty then pass).

class DominoGame {
  constructor() {
    this.hands = [[], []];
    this.boneyard = [];
    this.board = [];           // ordered chain of played tiles
    this.boardLeft = null;     // value exposed on left end
    this.boardRight = null;    // value exposed on right end
    this.currentPlayer = 0;
    this.consecutivePasses = 0;
    this.gameOver = false;
    this.winner = null;
  }

  init(numPlayers) {
    const allTiles = [];
    for (let i = 0; i <= 6; i++) {
      for (let j = i; j <= 6; j++) {
        allTiles.push([i, j]);
      }
    }
    this._shuffle(allTiles);

    this.hands[0] = allTiles.splice(0, 7);
    this.hands[1] = allTiles.splice(0, 7);
    this.boneyard = allTiles;

    this.currentPlayer = this._findStartingPlayer();
  }

  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  _findStartingPlayer() {
    // Player with highest double goes first
    for (let d = 6; d >= 0; d--) {
      for (let p = 0; p < 2; p++) {
        if (this.hands[p].some(t => t[0] === d && t[1] === d)) {
          return p;
        }
      }
    }
    return 0;
  }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };
    if (playerIndex !== this.currentPlayer) return { error: 'Not your turn' };

    if (action.type === 'play') {
      return this._playTile(playerIndex, action.tileIndex, action.side);
    } else if (action.type === 'draw') {
      return this._drawFromBoneyard(playerIndex);
    } else if (action.type === 'pass') {
      return this._pass(playerIndex);
    }

    return { error: 'Invalid action' };
  }

  _playTile(playerIndex, tileIndex, side) {
    const hand = this.hands[playerIndex];
    if (tileIndex < 0 || tileIndex >= hand.length) return { error: 'Invalid tile' };

    const tile = hand[tileIndex];

    // First tile on empty board
    if (this.board.length === 0) {
      hand.splice(tileIndex, 1);
      this.board.push(tile);
      this.boardLeft = tile[0];
      this.boardRight = tile[1];
      this.consecutivePasses = 0;
      return this._endTurn(playerIndex);
    }

    // Must play on a valid side
    if (!side) side = this._autoPickSide(tile);
    if (!side) return { error: 'Tile does not match either end' };

    if (side === 'left') {
      if (tile[1] === this.boardLeft) {
        hand.splice(tileIndex, 1);
        this.board.unshift(tile);
        this.boardLeft = tile[0];
      } else if (tile[0] === this.boardLeft) {
        hand.splice(tileIndex, 1);
        this.board.unshift([tile[1], tile[0]]);
        this.boardLeft = tile[1];
      } else {
        return { error: 'Tile does not match left end' };
      }
    } else if (side === 'right') {
      if (tile[0] === this.boardRight) {
        hand.splice(tileIndex, 1);
        this.board.push(tile);
        this.boardRight = tile[1];
      } else if (tile[1] === this.boardRight) {
        hand.splice(tileIndex, 1);
        this.board.push([tile[1], tile[0]]);
        this.boardRight = tile[0];
      } else {
        return { error: 'Tile does not match right end' };
      }
    } else {
      return { error: 'Invalid side (use "left" or "right")' };
    }

    this.consecutivePasses = 0;
    return this._endTurn(playerIndex);
  }

  _autoPickSide(tile) {
    const matchesLeft = tile[0] === this.boardLeft || tile[1] === this.boardLeft;
    const matchesRight = tile[0] === this.boardRight || tile[1] === this.boardRight;
    if (matchesLeft && !matchesRight) return 'left';
    if (matchesRight && !matchesLeft) return 'right';
    if (matchesLeft && matchesRight) return null; // player must choose
    return null;
  }

  _drawFromBoneyard(playerIndex) {
    if (this.boneyard.length === 0) {
      return { error: 'Boneyard is empty, you must pass' };
    }

    const tile = this.boneyard.pop();
    this.hands[playerIndex].push(tile);

    // Don't switch turns — player keeps drawing until they can play or boneyard empties
    return { drewTile: true, gameOver: false };
  }

  _pass(playerIndex) {
    // Can only pass if boneyard is empty and no playable tiles
    if (this.boneyard.length > 0) {
      return { error: 'You must draw from the pile first' };
    }
    if (this._hasPlayableTile(playerIndex)) {
      return { error: 'You have a playable tile' };
    }

    this.consecutivePasses++;
    if (this.consecutivePasses >= 2) {
      return this._endGameBlocked();
    }

    this.currentPlayer = 1 - this.currentPlayer;
    return { gameOver: false };
  }

  _hasPlayableTile(playerIndex) {
    if (this.board.length === 0) return true;
    return this.hands[playerIndex].some(
      t => t[0] === this.boardLeft || t[1] === this.boardLeft ||
           t[0] === this.boardRight || t[1] === this.boardRight
    );
  }

  _endTurn(playerIndex) {
    if (this.hands[playerIndex].length === 0) {
      this.gameOver = true;
      this.winner = playerIndex;
      return { gameOver: true, winner: playerIndex };
    }
    this.currentPlayer = 1 - this.currentPlayer;
    return { gameOver: false };
  }

  _endGameBlocked() {
    // Both players blocked — lowest pip count wins
    const score0 = this.hands[0].reduce((s, t) => s + t[0] + t[1], 0);
    const score1 = this.hands[1].reduce((s, t) => s + t[0] + t[1], 0);

    this.gameOver = true;
    if (score0 < score1) this.winner = 0;
    else if (score1 < score0) this.winner = 1;
    else this.winner = null; // draw

    return { gameOver: true, winner: this.winner };
  }

  getStateForPlayer(playerIndex) {
    return {
      gameType: 'domino',
      hand: this.hands[playerIndex],
      opponentTileCount: this.hands[1 - playerIndex].length,
      board: this.board,
      boardLeft: this.boardLeft,
      boardRight: this.boardRight,
      boneyardCount: this.boneyard.length,
      currentPlayer: this.currentPlayer,
      isMyTurn: this.currentPlayer === playerIndex,
      playerIndex,
      gameOver: this.gameOver,
      winner: this.winner,
      canPlay: this._hasPlayableTile(playerIndex),
      canDraw: this.boneyard.length > 0,
    };
  }
}

module.exports = DominoGame;
