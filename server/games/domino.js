// Domino game engine — Draw mode, first to TARGET_SCORE points wins (Plato-style)
// Each round: 7 tiles each, draw from boneyard, play or pass.
// Round ends when a player empties their hand or both are blocked.
// Round winner gets opponent's remaining pip count as points.
// Game ends when a player reaches the target score.

const TARGET_SCORE = 50;

class DominoGame {
  constructor() {
    this.scores = [0, 0];
    this.round = 0;
    this.roundOver = false;
    this.roundWinner = null;
    this.roundPoints = 0;
    this.pipCounts = [0, 0];
    this.gameOver = false;
    this.winner = null;

    this.hands = [[], []];
    this.boneyard = [];
    this.board = [];
    this.boardLeft = null;
    this.boardRight = null;
    this.currentPlayer = 0;
    this.consecutivePasses = 0;
  }

  init(numPlayers, options) {
    this.scores = [0, 0];
    this.round = 0;
    this._startNewRound();
  }

  _startNewRound() {
    this.round++;
    this.roundOver = false;
    this.roundWinner = null;
    this.roundPoints = 0;
    this.pipCounts = [0, 0];
    this.consecutivePasses = 0;
    this.board = [];
    this.boardLeft = null;
    this.boardRight = null;

    const allTiles = [];
    for (let i = 0; i <= 6; i++) {
      for (let j = i; j <= 6; j++) {
        allTiles.push([i, j]);
      }
    }
    this._shuffle(allTiles);

    this.hands = [allTiles.splice(0, 7), allTiles.splice(0, 7)];
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
    for (let d = 6; d >= 0; d--) {
      for (let p = 0; p < 2; p++) {
        if (this.hands[p].some(t => t[0] === d && t[1] === d)) return p;
      }
    }
    return 0;
  }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };

    if (action.type === 'next_round') {
      if (!this.roundOver) return { error: 'Round is not over yet' };
      if (this.gameOver) return { error: 'Game is already over' };
      this._startNewRound();
      return { newRound: true, gameOver: false };
    }

    if (this.roundOver) return { error: 'Round is over — waiting for next round' };
    if (playerIndex !== this.currentPlayer) return { error: 'Not your turn' };

    if (action.type === 'play') return this._playTile(playerIndex, action.tileIndex, action.side);
    if (action.type === 'draw') return this._drawFromBoneyard(playerIndex);
    if (action.type === 'pass') return this._pass(playerIndex);

    return { error: 'Invalid action' };
  }

  _playTile(playerIndex, tileIndex, side) {
    const hand = this.hands[playerIndex];
    if (tileIndex < 0 || tileIndex >= hand.length) return { error: 'Invalid tile' };
    const tile = hand[tileIndex];

    if (this.board.length === 0) {
      hand.splice(tileIndex, 1);
      this.board.push(tile);
      this.boardLeft = tile[0];
      this.boardRight = tile[1];
      this.consecutivePasses = 0;
      return this._endTurn(playerIndex);
    }

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
    }

    this.consecutivePasses = 0;
    return this._endTurn(playerIndex);
  }

  _autoPickSide(tile) {
    const mL = tile[0] === this.boardLeft || tile[1] === this.boardLeft;
    const mR = tile[0] === this.boardRight || tile[1] === this.boardRight;
    if (mL && !mR) return 'left';
    if (mR && !mL) return 'right';
    return null;
  }

  _drawFromBoneyard(playerIndex) {
    if (this.boneyard.length === 0) return { error: 'Boneyard is empty, you must pass' };
    this.hands[playerIndex].push(this.boneyard.pop());
    return { drewTile: true, gameOver: false };
  }

  _pass(playerIndex) {
    if (this.boneyard.length > 0) return { error: 'You must draw from the pile first' };
    if (this._hasPlayableTile(playerIndex)) return { error: 'You have a playable tile' };

    this.consecutivePasses++;
    if (this.consecutivePasses >= 2) return this._endRoundBlocked();

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

  _pipCount(playerIndex) {
    return this.hands[playerIndex].reduce((s, t) => s + t[0] + t[1], 0);
  }

  _endTurn(playerIndex) {
    if (this.hands[playerIndex].length === 0) {
      return this._endRound(playerIndex);
    }
    this.currentPlayer = 1 - this.currentPlayer;
    return { gameOver: false };
  }

  _endRound(roundWinner) {
    this.roundOver = true;
    this.roundWinner = roundWinner;
    const loserIndex = 1 - roundWinner;
    this.pipCounts = [this._pipCount(0), this._pipCount(1)];
    this.roundPoints = this.pipCounts[loserIndex];
    this.scores[roundWinner] += this.roundPoints;

    if (this.scores[roundWinner] >= TARGET_SCORE) {
      this.gameOver = true;
      this.winner = roundWinner;
      return { gameOver: true, winner: roundWinner, roundOver: true };
    }
    return { gameOver: false, roundOver: true, winner: roundWinner };
  }

  _endRoundBlocked() {
    this.pipCounts = [this._pipCount(0), this._pipCount(1)];

    if (this.pipCounts[0] < this.pipCounts[1]) {
      return this._endRoundBlockedWinner(0);
    } else if (this.pipCounts[1] < this.pipCounts[0]) {
      return this._endRoundBlockedWinner(1);
    }

    // Tie — no points, start new round
    this.roundOver = true;
    this.roundWinner = null;
    this.roundPoints = 0;
    return { gameOver: false, roundOver: true, winner: null };
  }

  _endRoundBlockedWinner(winner) {
    this.roundOver = true;
    this.roundWinner = winner;
    const loser = 1 - winner;
    this.roundPoints = this.pipCounts[loser] - this.pipCounts[winner];
    this.scores[winner] += this.roundPoints;

    if (this.scores[winner] >= TARGET_SCORE) {
      this.gameOver = true;
      this.winner = winner;
      return { gameOver: true, winner, roundOver: true };
    }
    return { gameOver: false, roundOver: true, winner };
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
      isMyTurn: !this.roundOver && this.currentPlayer === playerIndex,
      playerIndex,
      scores: this.scores,
      targetScore: TARGET_SCORE,
      round: this.round,
      roundOver: this.roundOver,
      roundWinner: this.roundWinner,
      roundPoints: this.roundPoints,
      pipCounts: this.pipCounts,
      gameOver: this.gameOver,
      winner: this.winner,
      canPlay: this._hasPlayableTile(playerIndex),
      canDraw: this.boneyard.length > 0,
    };
  }
}

module.exports = DominoGame;
