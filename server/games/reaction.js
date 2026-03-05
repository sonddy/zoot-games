const TURN_TIME_MS = 15000;

class ReactionGame {
  constructor() {
    this.round = 0;
    this.maxRounds = 5;
    this.scores = [0, 0];
    this.signalTime = null;
    this.reacted = [false, false];
    this.reactionTimes = [null, null];
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
    this.phase = 'waiting';
    this.roundResults = [];
    this.roundStartTime = null;
  }

  init(numPlayers, options = {}) {
    this.round = 0;
    this.maxRounds = 5;
    this.scores = [0, 0];
    this.gameOver = false;
    this.winner = null;
    this.roundResults = [];
    this.turnStartTime = Date.now();
    this._startRound();
  }

  _startRound() {
    this.reacted = [false, false];
    this.reactionTimes = [null, null];
    this.phase = 'waiting';
    const delay = 2000 + Math.floor(Math.random() * 4000);
    this.signalTime = Date.now() + delay;
    this.roundStartTime = Date.now();
    this.turnStartTime = Date.now();
  }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };
    if (action.type === 'resign') {
      this.gameOver = true;
      this.winner = 1 - playerIndex;
      return { gameOver: true, winner: this.winner, resigned: true };
    }

    if (action.type === 'react') {
      if (this.reacted[playerIndex]) return { error: 'Already reacted' };

      const now = Date.now();

      if (now < this.signalTime) {
        this.reacted[playerIndex] = true;
        this.reactionTimes[playerIndex] = -1;
      } else {
        this.reacted[playerIndex] = true;
        this.reactionTimes[playerIndex] = now - this.signalTime;
      }

      if (this.reacted[0] && this.reacted[1]) {
        return this._resolveRound();
      }

      this.turnStartTime = Date.now();
      return { gameOver: false };
    }

    return { error: 'Invalid action' };
  }

  _resolveRound() {
    this.round++;
    const t0 = this.reactionTimes[0];
    const t1 = this.reactionTimes[1];
    let roundWinner = null;

    if (t0 === -1 && t1 === -1) roundWinner = null;
    else if (t0 === -1) { roundWinner = 1; this.scores[1]++; }
    else if (t1 === -1) { roundWinner = 0; this.scores[0]++; }
    else if (t0 < t1) { roundWinner = 0; this.scores[0]++; }
    else if (t1 < t0) { roundWinner = 1; this.scores[1]++; }

    this.roundResults.push({ times: [t0, t1], winner: roundWinner });
    this.phase = 'result';

    if (this.round >= this.maxRounds) {
      this.gameOver = true;
      if (this.scores[0] > this.scores[1]) this.winner = 0;
      else if (this.scores[1] > this.scores[0]) this.winner = 1;
      else this.winner = null;
      return { gameOver: true, winner: this.winner };
    }

    setTimeout(() => this._startRound(), 2500);
    return { gameOver: false, newRound: true };
  }

  autoPlayForTimeout(playerIndex) {
    if (this.gameOver) return null;
    for (let i = 0; i < 2; i++) {
      if (!this.reacted[i]) {
        return this.handleAction(i, { type: 'react' });
      }
    }
    return null;
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);
    const now = Date.now();
    const signalActive = now >= this.signalTime && this.phase === 'waiting';

    return {
      gameType: 'reaction',
      round: this.round,
      maxRounds: this.maxRounds,
      scores: this.scores,
      phase: this.phase,
      signalActive,
      myReacted: this.reacted[playerIndex],
      oppReacted: this.reacted[1 - playerIndex],
      myTime: this.reactionTimes[playerIndex],
      oppTime: (this.reacted[0] && this.reacted[1]) ? this.reactionTimes[1 - playerIndex] : null,
      roundResults: this.roundResults,
      canReact: !this.reacted[playerIndex] && !this.gameOver && this.phase === 'waiting',
      currentPlayer: this.currentPlayer,
      isMyTurn: !this.reacted[playerIndex] && !this.gameOver && this.phase === 'waiting',
      playerIndex,
      gameOver: this.gameOver,
      winner: this.winner,
      turnTimeMs: TURN_TIME_MS,
      turnRemainingMs: remaining,
    };
  }
}

module.exports = ReactionGame;
