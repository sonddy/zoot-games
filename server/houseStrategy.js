'use strict';

// ════════════════════════════════════════════════════════════════════
// HOUSE STRATEGY
// Game-specific heuristics for the live agents. Each function takes
// (game, housePlayerIndex, agent) and returns either:
//   - { action: {...} } : a specific move to play via game.handleAction
//   - { fallback: true }: no opinion, defer to game.autoPlayForTimeout
//
// Skill-modulated mistake rate: even skill-5 agents intentionally
// blunder occasionally so wins still feel earned.
// ════════════════════════════════════════════════════════════════════

function mistakeChance(skill) {
  // skill 5 -> 0.05 (5% blunder), skill 1 -> 0.50
  return Math.max(0.05, 0.60 - 0.11 * skill);
}

function shouldBlunder(agent) {
  return Math.random() < mistakeChance((agent && agent.skill) || 3);
}

// ──────────────────────────────────────────────────────────────
// MORPION (15x15 Gomoku, 5-in-a-row)
// ──────────────────────────────────────────────────────────────
//
// Heuristic: for each empty cell near existing play, compute a score
// equal to (my pattern strength) + defensiveWeight * (opponent strength).
// Picks the highest-scoring cell, with a small skill-based blunder rate.

// Score (in a single direction line) after placing a stone at the cell
// for `me`. We look 4 cells each way from the placed stone to count
// stones-in-a-row and open ends.
function _lineScoreAt(board, size, cell, dr, dc, me, opp) {
  const r0 = Math.floor(cell / size);
  const c0 = cell % size;

  // Count consecutive `me` stones extending forward
  let forward = 0;
  let frFree = true;
  for (let s = 1; s < 5; s++) {
    const nr = r0 + dr * s, nc = c0 + dc * s;
    if (nr < 0 || nr >= size || nc < 0 || nc >= size) { frFree = false; break; }
    const v = board[nr * size + nc];
    if (v === me) forward++;
    else { frFree = (v === null); break; }
  }
  // Count consecutive `me` stones extending backward
  let backward = 0;
  let bkFree = true;
  for (let s = 1; s < 5; s++) {
    const nr = r0 - dr * s, nc = c0 - dc * s;
    if (nr < 0 || nr >= size || nc < 0 || nc >= size) { bkFree = false; break; }
    const v = board[nr * size + nc];
    if (v === me) backward++;
    else { bkFree = (v === null); break; }
  }

  const inARow = 1 + forward + backward;       // includes the placed stone
  const openEnds = (frFree ? 1 : 0) + (bkFree ? 1 : 0);

  if (inARow >= 5) return 100000;
  if (inARow === 4) {
    if (openEnds === 2) return 10000;          // open 4 - immediate winning threat
    if (openEnds === 1) return 1000;           // half-open 4
    return 0;
  }
  if (inARow === 3) {
    if (openEnds === 2) return 500;            // open 3
    if (openEnds === 1) return 100;            // half-open 3
    return 0;
  }
  if (inARow === 2) {
    if (openEnds === 2) return 50;
    if (openEnds === 1) return 10;
    return 0;
  }
  return openEnds; // 1-in-a-row, barely worth anything
}

function _cellScore(board, size, cell, me, opp) {
  if (board[cell] !== null) return -Infinity;
  let myScore = 0, oppScore = 0;
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (const [dr, dc] of dirs) {
    myScore  += _lineScoreAt(board, size, cell, dr, dc, me,  opp);
    oppScore += _lineScoreAt(board, size, cell, dr, dc, opp, me);
  }
  return { myScore, oppScore };
}

function morpionMove(game, idx, agent) {
  const board = game.board;
  const size = game.size;
  const me = idx;
  const opp = 1 - idx;
  const total = size * size;

  // Empty board: play center
  if (game.moveCount === 0) {
    const c = Math.floor(size / 2);
    return { action: { type: 'place', cell: c * size + c } };
  }

  // Candidate cells: only empties within 2 steps of any existing stone
  // (Gomoku always plays near contact; pruning makes this O(boardSize) not O(total))
  const candidates = new Set();
  for (let i = 0; i < total; i++) {
    if (board[i] === null) continue;
    const r = Math.floor(i / size), c = i % size;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
        const ni = nr * size + nc;
        if (board[ni] === null) candidates.add(ni);
      }
    }
  }
  if (candidates.size === 0) return { fallback: true };

  // Skill-based defensive weight: skill 5 blocks hard, skill 1 barely cares
  const skill = (agent && agent.skill) || 3;
  const defensiveWeight = 0.4 + 0.12 * skill; // skill 5 -> 1.0, skill 1 -> 0.52

  let best = null;
  const ranked = [];
  for (const cell of candidates) {
    const s = _cellScore(board, size, cell, me, opp);
    if (s === -Infinity) continue;
    const total = s.myScore + s.oppScore * defensiveWeight;
    ranked.push({ cell, total, myScore: s.myScore, oppScore: s.oppScore });
    if (!best || total > best.total) best = { cell, total };
  }

  if (!best) return { fallback: true };

  // Hard rules that override the skill-modulated score:
  //  1. If I can win this turn (>=10000), do it
  //  2. If opponent has an open 4 (>=10000), block it
  for (const r of ranked) {
    if (r.myScore >= 10000) return { action: { type: 'place', cell: r.cell } };
  }
  for (const r of ranked) {
    if (r.oppScore >= 10000) return { action: { type: 'place', cell: r.cell } };
  }

  // Skill-based blunder: pick a sub-optimal move from the top-N occasionally
  if (shouldBlunder(agent)) {
    ranked.sort((a, b) => b.total - a.total);
    const topN = Math.min(ranked.length, 6);
    const pick = ranked[Math.floor(Math.random() * topN)];
    return { action: { type: 'place', cell: pick.cell } };
  }

  return { action: { type: 'place', cell: best.cell } };
}

// ──────────────────────────────────────────────────────────────
// TIC TAC TOE — minimax (perfect play; with blunder rate it's still beatable)
// ──────────────────────────────────────────────────────────────

function _tttWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];
  for (const [a, b, c] of lines) {
    if (board[a] !== null && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  if (board.every(v => v !== null)) return 'draw';
  return null;
}

function _tttMinimax(board, current, me, opp, depth) {
  depth = depth || 0;
  const w = _tttWinner(board);
  // Depth-weighted scoring: prefer FASTER wins, SLOWER losses. This matters
  // when all our moves lose to optimal play — we'd rather force the opponent
  // through more moves (and they might blunder along the way) than walk into
  // the loss immediately.
  if (w === me)   return { score:  100 - depth };
  if (w === opp)  return { score: -100 + depth };
  if (w === 'draw') return { score: 0 };

  const isMax = (current === me);
  let best = { score: isMax ? -Infinity : Infinity, move: null };
  for (let i = 0; i < 9; i++) {
    if (board[i] !== null) continue;
    board[i] = current;
    const next = _tttMinimax(board, current === me ? opp : me, me, opp, depth + 1);
    board[i] = null;
    if (isMax ? next.score > best.score : next.score < best.score) {
      best = { score: next.score, move: i };
    }
  }
  return best;
}

function tttMove(game, idx, agent) {
  // TTT can be 3x3 (size 3) or larger (5x5, 7x7) with win-length 4.
  // Minimax is only tractable for 3x3; for larger boards, defer to the
  // game's already-decent autoplay (which does win-detection + blocking).
  if (game.size && game.size !== 3) return { fallback: true };

  const board = game.board.slice();
  if (board.length !== 9) return { fallback: true };
  const me = idx;
  const opp = 1 - idx;
  const skill = (agent && agent.skill) || 3;

  function emptiesOf(b) {
    const e = [];
    for (let i = 0; i < 9; i++) if (b[i] === null) e.push(i);
    return e;
  }

  // ALWAYS take an immediate win or block an immediate loss, regardless of
  // skill or blunder rate. This is what makes the agent feel competent —
  // humans hate it when their obvious 2-in-a-row goes unblocked.
  const empties = emptiesOf(board);
  if (empties.length === 0) return { fallback: true };
  for (const i of empties) {
    board[i] = me;
    const wmeWin = _tttWinner(board);
    board[i] = null;
    if (wmeWin === me) return { action: { type: 'place', cell: i } };
  }
  for (const i of empties) {
    board[i] = opp;
    const wOppWin = _tttWinner(board);
    board[i] = null;
    if (wOppWin === opp) return { action: { type: 'place', cell: i } };
  }

  // Low-skill agents play randomly often
  if (skill <= 2 && Math.random() < 0.6) {
    return { action: { type: 'place', cell: empties[Math.floor(Math.random() * empties.length)] } };
  }
  // skill 3: ~20% blunder; skill 4: ~10%; skill 5: ~5%
  const blunderRate = Math.max(0.05, 0.4 - 0.08 * skill);
  if (Math.random() < blunderRate) {
    return { action: { type: 'place', cell: empties[Math.floor(Math.random() * empties.length)] } };
  }

  const result = _tttMinimax(board, me, me, opp, 0);
  if (result.move === null) return { fallback: true };
  return { action: { type: 'place', cell: result.move } };
}

// ──────────────────────────────────────────────────────────────
// CONNECT 4 — minimax with depth scaled by skill
// ──────────────────────────────────────────────────────────────

const C4_ROWS = 6, C4_COLS = 7;

function _c4DropRow(board, col) {
  for (let r = C4_ROWS - 1; r >= 0; r--) {
    if (board[r * C4_COLS + col] === null) return r;
  }
  return -1;
}
function _c4Winner(board) {
  // horizontal
  for (let r = 0; r < C4_ROWS; r++) {
    for (let c = 0; c <= C4_COLS - 4; c++) {
      const v = board[r * C4_COLS + c];
      if (v !== null && v === board[r * C4_COLS + c + 1] && v === board[r * C4_COLS + c + 2] && v === board[r * C4_COLS + c + 3]) return v;
    }
  }
  // vertical
  for (let c = 0; c < C4_COLS; c++) {
    for (let r = 0; r <= C4_ROWS - 4; r++) {
      const v = board[r * C4_COLS + c];
      if (v !== null && v === board[(r + 1) * C4_COLS + c] && v === board[(r + 2) * C4_COLS + c] && v === board[(r + 3) * C4_COLS + c]) return v;
    }
  }
  // diagonals
  for (let r = 0; r <= C4_ROWS - 4; r++) {
    for (let c = 0; c <= C4_COLS - 4; c++) {
      const v = board[r * C4_COLS + c];
      if (v !== null && v === board[(r + 1) * C4_COLS + c + 1] && v === board[(r + 2) * C4_COLS + c + 2] && v === board[(r + 3) * C4_COLS + c + 3]) return v;
    }
  }
  for (let r = 3; r < C4_ROWS; r++) {
    for (let c = 0; c <= C4_COLS - 4; c++) {
      const v = board[r * C4_COLS + c];
      if (v !== null && v === board[(r - 1) * C4_COLS + c + 1] && v === board[(r - 2) * C4_COLS + c + 2] && v === board[(r - 3) * C4_COLS + c + 3]) return v;
    }
  }
  if (board.every(v => v !== null)) return 'draw';
  return null;
}
// Cheap evaluation: count threats of each player
function _c4Eval(board, me, opp) {
  const score = (player) => {
    let s = 0;
    const lines = [];
    // build all 4-cell windows
    for (let r = 0; r < C4_ROWS; r++)
      for (let c = 0; c <= C4_COLS - 4; c++)
        lines.push([r * C4_COLS + c, r * C4_COLS + c + 1, r * C4_COLS + c + 2, r * C4_COLS + c + 3]);
    for (let c = 0; c < C4_COLS; c++)
      for (let r = 0; r <= C4_ROWS - 4; r++)
        lines.push([r * C4_COLS + c, (r + 1) * C4_COLS + c, (r + 2) * C4_COLS + c, (r + 3) * C4_COLS + c]);
    for (let r = 0; r <= C4_ROWS - 4; r++)
      for (let c = 0; c <= C4_COLS - 4; c++)
        lines.push([r * C4_COLS + c, (r + 1) * C4_COLS + c + 1, (r + 2) * C4_COLS + c + 2, (r + 3) * C4_COLS + c + 3]);
    for (let r = 3; r < C4_ROWS; r++)
      for (let c = 0; c <= C4_COLS - 4; c++)
        lines.push([r * C4_COLS + c, (r - 1) * C4_COLS + c + 1, (r - 2) * C4_COLS + c + 2, (r - 3) * C4_COLS + c + 3]);
    for (const line of lines) {
      let mine = 0, theirs = 0;
      for (const i of line) {
        if (board[i] === player) mine++;
        else if (board[i] !== null) theirs++;
      }
      if (theirs > 0) continue;
      if (mine === 4) s += 1000;
      else if (mine === 3) s += 50;
      else if (mine === 2) s += 5;
    }
    return s;
  };
  return score(me) - score(opp);
}
function _c4Minimax(board, current, me, opp, depth, alpha, beta) {
  const w = _c4Winner(board);
  if (w === me)   return { score: 100000 - (10 - depth) }; // prefer faster wins
  if (w === opp)  return { score: -100000 + (10 - depth) };
  if (w === 'draw') return { score: 0 };
  if (depth === 0) return { score: _c4Eval(board, me, opp) };

  const isMax = (current === me);
  let best = { score: isMax ? -Infinity : Infinity, move: null };
  // search center columns first for better pruning
  const order = [3, 2, 4, 1, 5, 0, 6];
  for (const col of order) {
    const row = _c4DropRow(board, col);
    if (row < 0) continue;
    const idx = row * C4_COLS + col;
    board[idx] = current;
    const nxt = _c4Minimax(board, current === me ? opp : me, me, opp, depth - 1, alpha, beta);
    board[idx] = null;
    if (isMax) {
      if (nxt.score > best.score) best = { score: nxt.score, move: col };
      alpha = Math.max(alpha, best.score);
    } else {
      if (nxt.score < best.score) best = { score: nxt.score, move: col };
      beta = Math.min(beta, best.score);
    }
    if (alpha >= beta) break;
  }
  return best;
}
function c4Move(game, idx, agent) {
  // game.board is a 2D array [row][col]; flatten for minimax.
  let board;
  if (Array.isArray(game.board) && game.board.length === C4_ROWS && Array.isArray(game.board[0])) {
    board = [];
    for (let r = 0; r < C4_ROWS; r++)
      for (let c = 0; c < C4_COLS; c++)
        board.push(game.board[r][c] === undefined ? null : game.board[r][c]);
  } else if (Array.isArray(game.board) && game.board.length === C4_ROWS * C4_COLS) {
    board = game.board.slice();
  } else {
    return { fallback: true };
  }
  const me = idx;
  const opp = 1 - idx;
  const skill = (agent && agent.skill) || 3;
  // depth: skill 1 = 2, skill 5 = 6
  const depth = Math.max(2, skill + 1);

  // blunder
  if (Math.random() < mistakeChance(skill)) {
    const valid = [];
    for (let c = 0; c < C4_COLS; c++) if (_c4DropRow(board, c) >= 0) valid.push(c);
    if (valid.length === 0) return { fallback: true };
    return { action: { type: 'drop', col: valid[Math.floor(Math.random() * valid.length)] } };
  }

  const result = _c4Minimax(board, me, me, opp, depth, -Infinity, Infinity);
  if (result.move === null || result.move === undefined) return { fallback: true };
  return { action: { type: 'drop', col: result.move } };
}

// ──────────────────────────────────────────────────────────────
// NIM — optimal play uses XOR (Sprague-Grundy)
// ──────────────────────────────────────────────────────────────

// MISÈRE Nim — taking the last stone LOSES. Strategy:
//   - If 2+ piles have size >= 2: play normal-Nim XOR-to-zero
//   - If 0-1 piles have size >= 2: leave opponent an ODD number of 1-piles
//
// This is the proven optimal strategy for misère Nim.
function nimMove(game, idx, agent) {
  const piles = Array.isArray(game.piles) ? game.piles.slice() : null;
  if (!piles || piles.length === 0) return { fallback: true };
  const skill = (agent && agent.skill) || 3;

  const nonEmptyIdxs = piles.map((v, i) => v > 0 ? i : -1).filter(i => i >= 0);
  if (nonEmptyIdxs.length === 0) return { fallback: true };

  function randomMove() {
    const pi = nonEmptyIdxs[Math.floor(Math.random() * nonEmptyIdxs.length)];
    const take = 1 + Math.floor(Math.random() * Math.min(piles[pi], 3));
    return { action: { type: 'take', pile: pi, count: take } };
  }

  // Low skill: mostly random
  if (skill <= 2) return randomMove();
  // Even high skill blunders some of the time
  if (Math.random() < mistakeChance(skill)) return randomMove();

  const bigPiles = piles.map((v, i) => v >= 2 ? i : -1).filter(i => i >= 0);
  const onePiles = piles.filter(v => v === 1).length;

  // Endgame: 0 or 1 "big" piles -> misère adjustment.
  if (bigPiles.length === 0) {
    // All remaining piles are 1. Take 1 from any 1-pile (forced).
    return { action: { type: 'take', pile: nonEmptyIdxs[0], count: 1 } };
  }
  if (bigPiles.length === 1) {
    // One big pile + some 1-piles. Reduce big pile so total 1-piles is ODD.
    //   - If onePiles is even, leave big as 1  (ones+1 = odd)
    //   - If onePiles is odd,  leave big as 0  (ones stays odd)
    const bp = bigPiles[0];
    const target = (onePiles % 2 === 0) ? 1 : 0;
    const take = piles[bp] - target;
    if (take > 0) return { action: { type: 'take', pile: bp, count: take } };
  }

  // Normal Nim: leave XOR-sum at 0
  let xor = 0;
  for (const p of piles) xor ^= p;
  if (xor !== 0) {
    for (let i = 0; i < piles.length; i++) {
      const target = piles[i] ^ xor;
      if (target < piles[i]) {
        return { action: { type: 'take', pile: i, count: piles[i] - target } };
      }
    }
  }
  // Already in a losing position — take 1 from the largest pile.
  let bestPile = nonEmptyIdxs[0];
  for (const i of nonEmptyIdxs) if (piles[i] > piles[bestPile]) bestPile = i;
  return { action: { type: 'take', pile: bestPile, count: 1 } };
}

// ──────────────────────────────────────────────────────────────
// Dispatch
// ──────────────────────────────────────────────────────────────

function strategyMove(gameType, game, idx, agent) {
  try {
    switch (gameType) {
      case 'morpion':   return morpionMove(game, idx, agent);
      case 'tictactoe': return tttMove(game, idx, agent);
      case 'connect4':  return c4Move(game, idx, agent);
      case 'nim':       return nimMove(game, idx, agent);
      default:          return { fallback: true };
    }
  } catch (e) {
    console.warn('houseStrategy error for', gameType, '-', e.message);
    return { fallback: true };
  }
}

module.exports = { strategyMove };
