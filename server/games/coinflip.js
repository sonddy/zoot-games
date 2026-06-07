const TURN_TIME_MS = 15000;

class CoinFlipGame {
  constructor() {
    this.choices = [null, null];
    this.result = null;
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
    this.phase = 'choose';
  }

  init(numPlayers, options = {}) {
    this.choices = [null, null];
    this.result = null;
    this.currentPlayer = 0;
    this.gameOver = false;
    this.winner = null;
    this.phase = 'choose';
    this.turnStartTime = Date.now();
  }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };
    if (action.type === 'resign') {
      this.gameOver = true;
      this.winner = 1 - playerIndex;
      return { gameOver: true, winner: this.winner, resigned: true };
    }

    if (action.type === 'pick') {
      if (playerIndex !== 0) return { error: 'Only player 1 picks a side' };
      if (this.choices[0] !== null) return { error: 'Already picked' };
      if (action.side !== 'heads' && action.side !== 'tails') return { error: 'Pick heads or tails' };

      this.choices[0] = action.side;
      this.choices[1] = action.side === 'heads' ? 'tails' : 'heads';

      this.result = Math.random() < 0.5 ? 'heads' : 'tails';
      this.phase = 'result';
      this.gameOver = true;

      if (this.result === this.choices[0]) this.winner = 0;
      else this.winner = 1;

      return { gameOver: true, winner: this.winner };
    }

    return { error: 'Invalid action' };
  }

  autoPlayForTimeout(playerIndex) {
    if (playerIndex === 0 && this.choices[0] === null) {
      return this.handleAction(0, { type: 'pick', side: Math.random() < 0.5 ? 'heads' : 'tails' });
    }
    return null;
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);

    return {
      gameType: 'coinflip',
      myChoice: this.choices[playerIndex],
      oppChoice: this.choices[1 - playerIndex],
      result: this.result,
      phase: this.phase,
      currentPlayer: this.currentPlayer,
      isMyTurn: !this.gameOver && playerIndex === 0 && this.choices[0] === null,
      playerIndex,
      gameOver: this.gameOver,
      winner: this.winner,
      turnTimeMs: TURN_TIME_MS,
      turnRemainingMs: remaining,
    };
  }
}

module.exports = CoinFlipGame;
