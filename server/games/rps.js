const TURN_TIME_MS = 15000;
const CHOICES = ['rock', 'paper', 'scissors'];
const EMOJIS = { rock: '🪨', paper: '📄', scissors: '✂️' };
const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

class RPSGame {
  constructor() {
    this.choices = [null, null];
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
    this.round = 0;
    this.maxRounds = 3;
    this.scores = [0, 0];
    this.roundResults = [];
    this.revealRound = false;
  }

  init(numPlayers, options = {}) {
    this.choices = [null, null];
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.round = 0;
    this.maxRounds = 3;
    this.scores = [0, 0];
    this.roundResults = [];
    this.revealRound = false;
    this.turnStartTime = Date.now();
  }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };
    if (action.type === 'resign') {
      this.gameOver = true;
      this.winner = 1 - playerIndex;
      return { gameOver: true, winner: this.winner, resigned: true };
    }
    if (action.type !== 'choose') return { error: 'Invalid action' };
    if (!CHOICES.includes(action.choice)) return { error: 'Invalid choice' };
    if (this.choices[playerIndex] !== null) return { error: 'Already chose' };

    this.choices[playerIndex] = action.choice;

    if (this.choices[0] !== null && this.choices[1] !== null) {
      return this._resolveRound();
    }

    this.currentPlayer = 1 - playerIndex;
    this.turnStartTime = Date.now();
    return { gameOver: false, waitingForOpponent: true };
  }

  _resolveRound() {
    const c0 = this.choices[0];
    const c1 = this.choices[1];
    this.round++;
    let roundWinner = null;

    if (c0 === c1) {
      roundWinner = null;
    } else if (BEATS[c0] === c1) {
      roundWinner = 0;
      this.scores[0]++;
    } else {
      roundWinner = 1;
      this.scores[1]++;
    }

    this.roundResults.push({ choices: [c0, c1], winner: roundWinner });
    this.revealRound = true;

    const winsNeeded = Math.ceil(this.maxRounds / 2);
    if (this.scores[0] >= winsNeeded || this.scores[1] >= winsNeeded || this.round >= this.maxRounds) {
      this.gameOver = true;
      if (this.scores[0] > this.scores[1]) this.winner = 0;
      else if (this.scores[1] > this.scores[0]) this.winner = 1;
      else this.winner = null;
      return { gameOver: true, winner: this.winner };
    }

    setTimeout(() => {
      this.choices = [null, null];
      this.revealRound = false;
      this.currentPlayer = 0;
      this.turnStartTime = Date.now();
    }, 2000);

    return { gameOver: false, newRound: true };
  }

  autoPlayForTimeout(playerIndex) {
    if (this.gameOver) return null;
    for (let i = 0; i < 2; i++) {
      if (this.choices[i] === null) {
        const pick = CHOICES[Math.floor(Math.random() * 3)];
        return this.handleAction(i, { type: 'choose', choice: pick });
      }
    }
    return null;
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);
    const bothChosen = this.choices[0] !== null && this.choices[1] !== null;

    return {
      gameType: 'rps',
      myChoice: this.choices[playerIndex],
      oppChoice: bothChosen ? this.choices[1 - playerIndex] : null,
      oppChosen: this.choices[1 - playerIndex] !== null,
      scores: this.scores,
      round: this.round,
      maxRounds: this.maxRounds,
      roundResults: this.roundResults,
      revealRound: this.revealRound,
      canChoose: this.choices[playerIndex] === null && !this.gameOver && !this.revealRound,
      currentPlayer: this.currentPlayer,
      isMyTurn: this.choices[playerIndex] === null && !this.gameOver && !this.revealRound,
      playerIndex,
      gameOver: this.gameOver,
      winner: this.winner,
      turnTimeMs: TURN_TIME_MS,
      turnRemainingMs: remaining,
    };
  }
}

module.exports = RPSGame;
