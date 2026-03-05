const TURN_TIME_MS = 10000;

class DiceDuelGame {
  constructor() {
    this.dice = [null, null];
    this.rolled = [false, false];
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
    this.round = 0;
    this.maxRounds = 3;
    this.scores = [0, 0];
    this.roundResults = [];
  }

  init(numPlayers, options = {}) {
    this.dice = [null, null];
    this.rolled = [false, false];
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.round = 0;
    this.maxRounds = 3;
    this.scores = [0, 0];
    this.roundResults = [];
    this.turnStartTime = Date.now();
  }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };
    if (action.type === 'resign') {
      this.gameOver = true;
      this.winner = 1 - playerIndex;
      return { gameOver: true, winner: this.winner, resigned: true };
    }
    if (action.type !== 'roll') return { error: 'Invalid action' };
    if (this.rolled[playerIndex]) return { error: 'Already rolled' };

    this.dice[playerIndex] = [
      Math.floor(Math.random() * 6) + 1,
      Math.floor(Math.random() * 6) + 1,
    ];
    this.rolled[playerIndex] = true;

    if (this.rolled[0] && this.rolled[1]) {
      return this._resolveRound();
    }

    this.currentPlayer = 1 - playerIndex;
    this.turnStartTime = Date.now();
    return { gameOver: false, waitingForOpponent: true };
  }

  _resolveRound() {
    const sum0 = this.dice[0][0] + this.dice[0][1];
    const sum1 = this.dice[1][0] + this.dice[1][1];
    this.round++;
    let roundWinner = null;

    if (sum0 > sum1) { roundWinner = 0; this.scores[0]++; }
    else if (sum1 > sum0) { roundWinner = 1; this.scores[1]++; }

    this.roundResults.push({ dice: [this.dice[0].slice(), this.dice[1].slice()], sums: [sum0, sum1], winner: roundWinner });

    const winsNeeded = Math.ceil(this.maxRounds / 2);
    if (this.scores[0] >= winsNeeded || this.scores[1] >= winsNeeded || this.round >= this.maxRounds) {
      this.gameOver = true;
      if (this.scores[0] > this.scores[1]) this.winner = 0;
      else if (this.scores[1] > this.scores[0]) this.winner = 1;
      else this.winner = null;
      return { gameOver: true, winner: this.winner };
    }

    this.dice = [null, null];
    this.rolled = [false, false];
    this.currentPlayer = 0;
    this.turnStartTime = Date.now();
    return { gameOver: false, newRound: true };
  }

  autoPlayForTimeout(playerIndex) {
    if (this.gameOver) return null;
    for (let i = 0; i < 2; i++) {
      if (!this.rolled[i]) {
        return this.handleAction(i, { type: 'roll' });
      }
    }
    return null;
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);
    const bothRolled = this.rolled[0] && this.rolled[1];

    return {
      gameType: 'diceduel',
      myDice: this.rolled[playerIndex] ? this.dice[playerIndex] : null,
      oppDice: bothRolled ? this.dice[1 - playerIndex] : null,
      oppRolled: this.rolled[1 - playerIndex],
      scores: this.scores,
      round: this.round,
      maxRounds: this.maxRounds,
      roundResults: this.roundResults,
      canRoll: !this.rolled[playerIndex] && !this.gameOver,
      currentPlayer: this.currentPlayer,
      isMyTurn: !this.rolled[playerIndex] && !this.gameOver,
      playerIndex,
      gameOver: this.gameOver,
      winner: this.winner,
      turnTimeMs: TURN_TIME_MS,
      turnRemainingMs: remaining,
    };
  }
}

module.exports = DiceDuelGame;
