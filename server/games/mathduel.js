const TURN_TIME_MS = 15000;

class MathDuelGame {
  constructor() {
    this.problem = null;
    this.answer = null;
    this.answered = [false, false];
    this.correct = [false, false];
    this.round = 0;
    this.maxRounds = 5;
    this.scores = [0, 0];
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
    this.roundResults = [];
  }

  init(numPlayers, options = {}) {
    this.round = 0;
    this.maxRounds = 5;
    this.scores = [0, 0];
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.roundResults = [];
    this._newProblem();
  }

  _newProblem() {
    const ops = ['+', '-', '×'];
    const op = ops[Math.floor(Math.random() * ops.length)];
    let a, b, answer;

    if (op === '+') {
      a = Math.floor(Math.random() * 50) + 10;
      b = Math.floor(Math.random() * 50) + 10;
      answer = a + b;
    } else if (op === '-') {
      a = Math.floor(Math.random() * 50) + 30;
      b = Math.floor(Math.random() * 30) + 1;
      answer = a - b;
    } else {
      a = Math.floor(Math.random() * 12) + 2;
      b = Math.floor(Math.random() * 12) + 2;
      answer = a * b;
    }

    this.problem = a + ' ' + op + ' ' + b;
    this.answer = answer;
    this.answered = [false, false];
    this.correct = [false, false];
    this.turnStartTime = Date.now();
  }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };
    if (action.type === 'resign') {
      this.gameOver = true;
      this.winner = 1 - playerIndex;
      return { gameOver: true, winner: this.winner, resigned: true };
    }

    if (action.type === 'answer') {
      if (this.answered[playerIndex]) return { error: 'Already answered' };
      const userAnswer = parseInt(action.value);
      if (isNaN(userAnswer)) return { error: 'Invalid answer' };

      this.answered[playerIndex] = true;
      this.correct[playerIndex] = userAnswer === this.answer;

      if (this.correct[playerIndex]) {
        this.scores[playerIndex]++;
      }

      if (this.answered[0] && this.answered[1]) {
        return this._resolveRound();
      }

      if (this.correct[playerIndex]) {
        return this._resolveRound();
      }

      this.turnStartTime = Date.now();
      return { gameOver: false };
    }

    return { error: 'Invalid action' };
  }

  _resolveRound() {
    this.round++;
    this.roundResults.push({
      problem: this.problem,
      answer: this.answer,
      correct: [this.correct[0], this.correct[1]],
    });

    if (this.round >= this.maxRounds) {
      this.gameOver = true;
      if (this.scores[0] > this.scores[1]) this.winner = 0;
      else if (this.scores[1] > this.scores[0]) this.winner = 1;
      else this.winner = null;
      return { gameOver: true, winner: this.winner };
    }

    this._newProblem();
    return { gameOver: false, newRound: true };
  }

  autoPlayForTimeout(playerIndex) {
    if (this.gameOver) return null;
    for (let i = 0; i < 2; i++) {
      if (!this.answered[i]) {
        return this.handleAction(i, { type: 'answer', value: '-999' });
      }
    }
    return null;
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);

    return {
      gameType: 'mathduel',
      problem: this.problem,
      round: this.round,
      maxRounds: this.maxRounds,
      scores: this.scores,
      myAnswered: this.answered[playerIndex],
      oppAnswered: this.answered[1 - playerIndex],
      correctAnswer: (this.answered[0] && this.answered[1]) ? this.answer : null,
      roundResults: this.roundResults,
      canAnswer: !this.answered[playerIndex] && !this.gameOver,
      currentPlayer: this.currentPlayer,
      isMyTurn: !this.answered[playerIndex] && !this.gameOver,
      playerIndex,
      gameOver: this.gameOver,
      winner: this.winner,
      turnTimeMs: TURN_TIME_MS,
      turnRemainingMs: remaining,
    };
  }
}

module.exports = MathDuelGame;
