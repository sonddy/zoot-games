const TURN_TIME_MS = 30000;
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const RANK_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };

function createDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s, value: RANK_VALUES[r] });
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const HAND_RANKS = {
  HIGH_CARD: 0, PAIR: 1, TWO_PAIR: 2, THREE_KIND: 3,
  STRAIGHT: 4, FLUSH: 5, FULL_HOUSE: 6, FOUR_KIND: 7,
  STRAIGHT_FLUSH: 8, ROYAL_FLUSH: 9
};

function evaluateHand(cards) {
  const combos = getCombinations(cards, 5);
  let best = null;
  for (const combo of combos) {
    const score = scoreHand(combo);
    if (!best || compareScores(score, best) > 0) best = score;
  }
  return best;
}

function getCombinations(arr, k) {
  const result = [];
  function combo(start, chosen) {
    if (chosen.length === k) { result.push([...chosen]); return; }
    for (let i = start; i < arr.length; i++) {
      chosen.push(arr[i]);
      combo(i + 1, chosen);
      chosen.pop();
    }
  }
  combo(0, []);
  return result;
}

function scoreHand(cards) {
  const values = cards.map(c => c.value).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  const counts = {};
  values.forEach(v => counts[v] = (counts[v] || 0) + 1);
  const groups = Object.entries(counts).map(([v, c]) => ({ value: parseInt(v), count: c }));
  groups.sort((a, b) => b.count - a.count || b.value - a.value);

  let isStraight = false;
  const unique = [...new Set(values)].sort((a, b) => b - a);
  if (unique.length === 5 && unique[0] - unique[4] === 4) isStraight = true;
  if (unique.join(',') === '14,5,4,3,2') isStraight = true;

  let rank, kickers;
  if (isFlush && isStraight && unique[0] === 14 && unique[1] === 13) {
    rank = HAND_RANKS.ROYAL_FLUSH; kickers = values;
  } else if (isFlush && isStraight) {
    rank = HAND_RANKS.STRAIGHT_FLUSH; kickers = values;
  } else if (groups[0].count === 4) {
    rank = HAND_RANKS.FOUR_KIND; kickers = [groups[0].value, groups[1].value];
  } else if (groups[0].count === 3 && groups[1].count === 2) {
    rank = HAND_RANKS.FULL_HOUSE; kickers = [groups[0].value, groups[1].value];
  } else if (isFlush) {
    rank = HAND_RANKS.FLUSH; kickers = values;
  } else if (isStraight) {
    rank = HAND_RANKS.STRAIGHT; kickers = values;
  } else if (groups[0].count === 3) {
    rank = HAND_RANKS.THREE_KIND; kickers = [groups[0].value, ...values.filter(v => v !== groups[0].value)];
  } else if (groups[0].count === 2 && groups[1].count === 2) {
    rank = HAND_RANKS.TWO_PAIR; kickers = [groups[0].value, groups[1].value, groups[2].value];
  } else if (groups[0].count === 2) {
    rank = HAND_RANKS.PAIR; kickers = [groups[0].value, ...values.filter(v => v !== groups[0].value)];
  } else {
    rank = HAND_RANKS.HIGH_CARD; kickers = values;
  }
  return { rank, kickers };
}

function compareScores(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < a.kickers.length; i++) {
    if (a.kickers[i] !== b.kickers[i]) return a.kickers[i] - b.kickers[i];
  }
  return 0;
}

const HAND_NAMES = ['High Card','Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush','Royal Flush'];

class PokerGame {
  constructor() {
    this.holeCards = [[], []];
    this.community = [];
    this.deck = [];
    this.pot = 0;
    this.bets = [0, 0];
    this.chips = [100, 100];
    this.currentPlayer = 0;
    this.phase = 'preflop';
    this.gameOver = false;
    this.winner = null;
    this.turnStartTime = Date.now();
    this.lastAction = null;
    this.folded = [false, false];
    this.checked = [false, false];
    this.dealer = 0;
    this.minRaise = 2;
    this.revealCards = false;
  }

  init(numPlayers, options = {}) {
    this.deck = shuffle(createDeck());
    this.holeCards[0] = [this.deck.pop(), this.deck.pop()];
    this.holeCards[1] = [this.deck.pop(), this.deck.pop()];
    this.community = [];
    this.dealer = Math.random() < 0.5 ? 0 : 1;
    this.chips = [100, 100];
    this.bets = [1, 2];
    this.chips[this.dealer] -= 1;
    this.chips[1 - this.dealer] -= 2;
    this.pot = 3;
    this.currentPlayer = this.dealer;
    this.phase = 'preflop';
    this.turnStartTime = Date.now();
    this.checked = [false, false];
    this.minRaise = 2;
  }

  handleAction(playerIndex, action) {
    if (this.gameOver) return { error: 'Game is over' };
    if (action.type === 'resign') {
      this.gameOver = true;
      this.winner = 1 - playerIndex;
      return { gameOver: true, winner: this.winner, resigned: true };
    }
    if (playerIndex !== this.currentPlayer) return { error: 'Not your turn' };

    const opp = 1 - playerIndex;

    if (action.type === 'fold') {
      this.folded[playerIndex] = true;
      this.gameOver = true;
      this.winner = opp;
      return { gameOver: true, winner: opp, folded: true };
    }

    if (action.type === 'check') {
      const diff = this.bets[opp] - this.bets[playerIndex];
      if (diff > 0) return { error: 'Cannot check, must call or raise' };
      this.checked[playerIndex] = true;
      if (this.checked[0] && this.checked[1]) {
        return this._nextPhase();
      }
      this.currentPlayer = opp;
      this.turnStartTime = Date.now();
      return { gameOver: false };
    }

    if (action.type === 'call') {
      const diff = this.bets[opp] - this.bets[playerIndex];
      if (diff <= 0) return { error: 'Nothing to call' };
      const callAmt = Math.min(diff, this.chips[playerIndex]);
      this.chips[playerIndex] -= callAmt;
      this.bets[playerIndex] += callAmt;
      this.pot += callAmt;
      return this._nextPhase();
    }

    if (action.type === 'raise') {
      const amount = action.amount || this.minRaise;
      const diff = this.bets[opp] - this.bets[playerIndex];
      const totalNeeded = diff + amount;
      if (totalNeeded > this.chips[playerIndex]) return { error: 'Not enough chips' };
      this.chips[playerIndex] -= totalNeeded;
      this.bets[playerIndex] += totalNeeded;
      this.pot += totalNeeded;
      this.minRaise = amount;
      this.checked = [false, false];
      this.currentPlayer = opp;
      this.turnStartTime = Date.now();
      this.lastAction = { player: playerIndex, type: 'raise', amount };
      return { gameOver: false };
    }

    if (action.type === 'allin') {
      const allAmt = this.chips[playerIndex];
      this.bets[playerIndex] += allAmt;
      this.pot += allAmt;
      this.chips[playerIndex] = 0;
      const diff = this.bets[playerIndex] - this.bets[opp];
      if (diff > 0) {
        this.currentPlayer = opp;
        this.turnStartTime = Date.now();
        this.lastAction = { player: playerIndex, type: 'allin' };
        return { gameOver: false };
      }
      return this._showdown();
    }

    return { error: 'Invalid action' };
  }

  _nextPhase() {
    this.checked = [false, false];
    this.bets = [0, 0];

    if (this.phase === 'preflop') {
      this.phase = 'flop';
      this.deck.pop();
      this.community.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
    } else if (this.phase === 'flop') {
      this.phase = 'turn';
      this.deck.pop();
      this.community.push(this.deck.pop());
    } else if (this.phase === 'turn') {
      this.phase = 'river';
      this.deck.pop();
      this.community.push(this.deck.pop());
    } else if (this.phase === 'river') {
      return this._showdown();
    }

    this.currentPlayer = 1 - this.dealer;
    this.turnStartTime = Date.now();
    return { gameOver: false, newPhase: this.phase };
  }

  _showdown() {
    this.revealCards = true;
    const all0 = [...this.holeCards[0], ...this.community];
    const all1 = [...this.holeCards[1], ...this.community];
    const score0 = evaluateHand(all0);
    const score1 = evaluateHand(all1);
    const cmp = compareScores(score0, score1);

    this.gameOver = true;
    this.handName = [HAND_NAMES[score0.rank], HAND_NAMES[score1.rank]];
    if (cmp > 0) this.winner = 0;
    else if (cmp < 0) this.winner = 1;
    else this.winner = null;
    return { gameOver: true, winner: this.winner, showdown: true };
  }

  autoPlayForTimeout(playerIndex) {
    const opp = 1 - playerIndex;
    const diff = this.bets[opp] - this.bets[playerIndex];
    if (diff > 0) {
      return this.handleAction(playerIndex, { type: 'fold' });
    }
    return this.handleAction(playerIndex, { type: 'check' });
  }

  getStateForPlayer(playerIndex) {
    const elapsed = Date.now() - this.turnStartTime;
    const remaining = Math.max(0, TURN_TIME_MS - elapsed);
    const opp = 1 - playerIndex;
    const callAmount = Math.max(0, this.bets[opp] - this.bets[playerIndex]);

    return {
      gameType: 'poker',
      holeCards: this.holeCards[playerIndex],
      oppHoleCards: this.revealCards ? this.holeCards[opp] : null,
      community: this.community,
      pot: this.pot,
      myChips: this.chips[playerIndex],
      oppChips: this.chips[opp],
      myBet: this.bets[playerIndex],
      oppBet: this.bets[opp],
      phase: this.phase,
      callAmount,
      canCheck: callAmount === 0,
      isDealer: this.dealer === playerIndex,
      currentPlayer: this.currentPlayer,
      isMyTurn: !this.gameOver && this.currentPlayer === playerIndex,
      playerIndex,
      gameOver: this.gameOver,
      winner: this.winner,
      handName: this.handName || null,
      lastAction: this.lastAction,
      turnTimeMs: TURN_TIME_MS,
      turnRemainingMs: remaining,
    };
  }
}

module.exports = PokerGame;
