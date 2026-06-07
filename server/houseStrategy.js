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
  // HARD MODE: skill 5 ~1%, skill 4 ~4%, skill 3 ~12%, skill 2 ~20%, skill 1 ~28%
  return Math.max(0.01, 0.36 - 0.08 * skill);
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

  // HARD MODE: skill 3+ never blunder to pure random; blunder rate is tight.
  // skill 3 ~12%, skill 4 ~4%, skill 5 ~1%.
  const blunderRate = mistakeChance(skill);
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
  // HARD MODE depth: skill 1 = 3, skill 5 = 8 (Connect 4 branching is low)
  const depth = Math.max(3, skill + 3);

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

  // HARD MODE: always play optimal Nim with a small blunder rate.
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
// REVERSI / OTHELLO — corner priority + greedy flip count
// ──────────────────────────────────────────────────────────────
//
// Reversi has a famous heuristic: corners > X-squares (cells diagonal to
// corners are bad to play early), edges > middle. We add a small weight
// for mobility (number of moves we leave) and flip count.

const REVERSI_WEIGHTS = [
  [120,-20, 20,  5,  5, 20,-20,120],
  [-20,-40, -5, -5, -5, -5,-40,-20],
  [ 20, -5, 15,  3,  3, 15, -5, 20],
  [  5, -5,  3,  3,  3,  3, -5,  5],
  [  5, -5,  3,  3,  3,  3, -5,  5],
  [ 20, -5, 15,  3,  3, 15, -5, 20],
  [-20,-40, -5, -5, -5, -5,-40,-20],
  [120,-20, 20,  5,  5, 20,-20,120],
];

function reversiMove(game, idx, agent) {
  if (typeof game._getValidMoves !== 'function' || typeof game._getFlips !== 'function') return { fallback: true };
  const moves = game._getValidMoves(idx);
  if (!moves || moves.length === 0) return { fallback: true };
  const skill = (agent && agent.skill) || 3;

  // HARD MODE: always use positional heuristic; only the small mistakeChance applies.
  if (Math.random() < mistakeChance(skill)) {
    const pick = moves[Math.floor(Math.random() * moves.length)];
    return { action: { type: 'place', row: pick.row, col: pick.col } };
  }

  let bestScore = -Infinity;
  let best = moves[0];
  for (const m of moves) {
    const flips = game._getFlips(m.row, m.col, idx);
    const positional = REVERSI_WEIGHTS[m.row][m.col];
    // Higher skill weights position more heavily; flip count is a secondary
    // factor (in Reversi having too many discs early can be bad — "mobility").
    const flipWeight = 1.0; // small weight; positional dominates
    const score = positional * (1 + skill * 0.3) + flips.length * flipWeight;
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return { action: { type: 'place', row: best.row, col: best.col } };
}

// ──────────────────────────────────────────────────────────────
// MEMORY — track revealed cards; skill controls memory fidelity
// ──────────────────────────────────────────────────────────────

function memoryMove(game, idx, agent) {
  if (!Array.isArray(game.cards) || !Array.isArray(game.matched)) return { fallback: true };
  const total = game.cards.length;
  const skill = (agent && agent.skill) || 3;

  // Build the bot's memory map: symbol -> [card indices it has seen].
  // We update it from currently-revealed cards each turn.
  if (!game._botMemory) game._botMemory = {};
  for (let i = 0; i < total; i++) {
    if (game.matched[i] || game.revealed[i]) {
      const sym = game.cards[i];
      if (!game._botMemory[sym]) game._botMemory[sym] = new Set();
      game._botMemory[sym].add(i);
    }
  }

  // HARD MODE recall: skill 5 = 100% perfect, skill 4 = ~95%, skill 3 = ~85%,
  // skill 2 = ~70%, skill 1 = ~55%. The skill-5 agent essentially never misses
  // a known pair.
  const recallChance = skill >= 5 ? 1.0 : (0.45 + 0.13 * skill);
  const usableMemory = {};
  for (const sym of Object.keys(game._botMemory)) {
    for (const i of game._botMemory[sym]) {
      if (game.matched[i] || game.flipped.includes(i)) continue;
      if (Math.random() < recallChance) {
        if (!usableMemory[sym]) usableMemory[sym] = [];
        usableMemory[sym].push(i);
      }
    }
  }

  const available = [];
  for (let i = 0; i < total; i++) {
    if (!game.matched[i] && !game.flipped.includes(i)) available.push(i);
  }
  if (available.length === 0) return { fallback: true };

  if (game.flipped.length === 0) {
    // First flip of the turn. If I remember a matching pair, flip one of them.
    for (const sym of Object.keys(usableMemory)) {
      if (usableMemory[sym].length >= 2) {
        return { action: { type: 'flip', index: usableMemory[sym][0] } };
      }
    }
    // Otherwise: flip an unknown card to learn (lower skill picks more randomly)
    const unknown = available.filter(i => !game.revealed[i]);
    const pool = unknown.length > 0 ? unknown : available;
    return { action: { type: 'flip', index: pool[Math.floor(Math.random() * pool.length)] } };
  } else {
    // Second flip — try to match the first revealed card.
    const firstIdx = game.flipped[0];
    const firstSym = game.cards[firstIdx];
    if (usableMemory[firstSym]) {
      for (const idx2 of usableMemory[firstSym]) {
        if (idx2 !== firstIdx && available.includes(idx2)) {
          return { action: { type: 'flip', index: idx2 } };
        }
      }
    }
    // No match remembered: flip an unknown card
    const unknown = available.filter(i => !game.revealed[i]);
    const pool = unknown.length > 0 ? unknown : available;
    return { action: { type: 'flip', index: pool[Math.floor(Math.random() * pool.length)] } };
  }
}

// ──────────────────────────────────────────────────────────────
// BATTLESHIP — hunt mode (parity sweep) + target mode (after hits)
// ──────────────────────────────────────────────────────────────

const BS_SIZE = 10;

function _bsHits(game, idx) {
  // Cells where idx fired AND hit a ship on the opponent's board.
  const opp = 1 - idx;
  const hits = [];
  for (let r = 0; r < BS_SIZE; r++) {
    for (let c = 0; c < BS_SIZE; c++) {
      if (game.shots[idx][r][c] && game.boards[opp][r][c] !== null) {
        hits.push({ r, c, shipId: game.boards[opp][r][c] });
      }
    }
  }
  return hits;
}

function _bsUnshot(game, idx) {
  const out = [];
  for (let r = 0; r < BS_SIZE; r++)
    for (let c = 0; c < BS_SIZE; c++)
      if (!game.shots[idx][r][c]) out.push({ r, c });
  return out;
}

function battleshipMove(game, idx, agent) {
  if (!game.shots || !game.boards) return { fallback: true };
  const skill = (agent && agent.skill) || 3;
  const opp = 1 - idx;

  // Target mode: are there hits on ships that are NOT yet sunk? Continue
  // attacking around them.
  const hits = _bsHits(game, idx).filter(h => {
    const ship = game.ships[opp][h.shipId];
    return ship && !ship.sunk;
  });

  // Skill-based blunder
  if (Math.random() < mistakeChance(skill)) {
    const all = _bsUnshot(game, idx);
    if (all.length === 0) return { fallback: true };
    const pick = all[Math.floor(Math.random() * all.length)];
    return { action: { type: 'fire', row: pick.r, col: pick.c } };
  }

  if (hits.length > 0) {
    // If 2+ hits are colinear, infer the ship orientation and extend.
    const byShip = {};
    for (const h of hits) {
      if (!byShip[h.shipId]) byShip[h.shipId] = [];
      byShip[h.shipId].push(h);
    }
    for (const shipHits of Object.values(byShip)) {
      if (shipHits.length >= 2) {
        const sameRow = shipHits.every(h => h.r === shipHits[0].r);
        const sameCol = shipHits.every(h => h.c === shipHits[0].c);
        if (sameRow) {
          const cs = shipHits.map(h => h.c).sort((a,b)=>a-b);
          const ends = [{ r: shipHits[0].r, c: cs[0] - 1 }, { r: shipHits[0].r, c: cs[cs.length-1] + 1 }];
          for (const e of ends) {
            if (e.c >= 0 && e.c < BS_SIZE && !game.shots[idx][e.r][e.c]) {
              return { action: { type: 'fire', row: e.r, col: e.c } };
            }
          }
        }
        if (sameCol) {
          const rs = shipHits.map(h => h.r).sort((a,b)=>a-b);
          const ends = [{ r: rs[0] - 1, c: shipHits[0].c }, { r: rs[rs.length-1] + 1, c: shipHits[0].c }];
          for (const e of ends) {
            if (e.r >= 0 && e.r < BS_SIZE && !game.shots[idx][e.r][e.c]) {
              return { action: { type: 'fire', row: e.r, col: e.c } };
            }
          }
        }
      }
    }
    // Single hit: try 4 neighbors
    const dirs = [[-1,0],[1,0],[0,-1],[0,1]];
    for (const h of hits) {
      for (const [dr, dc] of dirs) {
        const nr = h.r + dr, nc = h.c + dc;
        if (nr >= 0 && nr < BS_SIZE && nc >= 0 && nc < BS_SIZE && !game.shots[idx][nr][nc]) {
          return { action: { type: 'fire', row: nr, col: nc } };
        }
      }
    }
  }

  // Hunt mode: parity grid — shortest ship is size 2, so cells with
  // (r+c) % 2 === 0 are sufficient to find any ship.
  const parity = _bsUnshot(game, idx).filter(p => (p.r + p.c) % 2 === 0);
  const pool = parity.length > 0 ? parity : _bsUnshot(game, idx);
  if (pool.length === 0) return { fallback: true };
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return { action: { type: 'fire', row: pick.r, col: pick.c } };
}

// ──────────────────────────────────────────────────────────────
// MANCALA — extra-turn / capture detection + 1-ply lookahead
// ──────────────────────────────────────────────────────────────

function _mancalaApply(pits, playerIndex, pitIndex) {
  // Returns { newPits, extraTurn, captured }
  const p = pits.slice();
  const seeds = p[pitIndex];
  if (seeds === 0) return null;
  p[pitIndex] = 0;
  const oppStore = playerIndex === 0 ? 13 : 6;
  let pos = pitIndex;
  for (let i = 0; i < seeds; i++) {
    pos = (pos + 1) % 14;
    if (pos === oppStore) pos = (pos + 1) % 14;
    p[pos]++;
  }
  const myStore = playerIndex === 0 ? 6 : 13;
  const extraTurn = pos === myStore;
  let captured = 0;
  if (!extraTurn) {
    const [lo, hi] = playerIndex === 0 ? [0, 5] : [7, 12];
    if (pos >= lo && pos <= hi && p[pos] === 1) {
      const opposite = 12 - pos;
      if (p[opposite] > 0) {
        captured = p[opposite] + 1;
        p[myStore] += captured;
        p[opposite] = 0;
        p[pos] = 0;
      }
    }
  }
  return { newPits: p, extraTurn, captured };
}

function _mancalaScore(pits, playerIndex) {
  // Heuristic: my store - opp store + (some weight) * seeds-on-my-side
  const myStore = playerIndex === 0 ? 6 : 13;
  const oppStore = playerIndex === 0 ? 13 : 6;
  const [mlo, mhi] = playerIndex === 0 ? [0, 5] : [7, 12];
  let mySide = 0;
  for (let i = mlo; i <= mhi; i++) mySide += pits[i];
  return (pits[myStore] - pits[oppStore]) * 4 + mySide * 0.5;
}

function mancalaMove(game, idx, agent) {
  if (!Array.isArray(game.pits)) return { fallback: true };
  const pits = game.pits;
  const skill = (agent && agent.skill) || 3;
  const [lo, hi] = idx === 0 ? [0, 5] : [7, 12];

  const legalPits = [];
  for (let i = lo; i <= hi; i++) if (pits[i] > 0) legalPits.push(i);
  if (legalPits.length === 0) return { fallback: true };

  if (Math.random() < mistakeChance(skill)) {
    const pick = legalPits[Math.floor(Math.random() * legalPits.length)];
    return { action: { type: 'sow', pit: pick } };
  }

  // 1-ply lookahead with extra-turn chains
  let best = null;
  let bestScore = -Infinity;
  for (const pit of legalPits) {
    const r = _mancalaApply(pits, idx, pit);
    if (!r) continue;
    let score = _mancalaScore(r.newPits, idx);
    if (r.extraTurn) score += 8;            // extra turns are very valuable
    if (r.captured > 0) score += r.captured * 3;
    if (score > bestScore) { bestScore = score; best = pit; }
  }
  if (best === null) best = legalPits[0];
  return { action: { type: 'sow', pit: best } };
}

// ──────────────────────────────────────────────────────────────
// DOTS & BOXES — claim boxes; avoid giving 3rd side; smallest sacrifice
// ──────────────────────────────────────────────────────────────

function _dbCountSides(hLines, vLines, r, c) {
  let n = 0;
  if (hLines[r][c]     !== null) n++;
  if (hLines[r + 1][c] !== null) n++;
  if (vLines[r][c]     !== null) n++;
  if (vLines[r][c + 1] !== null) n++;
  return n;
}

function _dbSimulateLine(game, line) {
  // Returns { boxesMade, newHLines, newVLines }
  const newH = game.hLines.map(row => row.slice());
  const newV = game.vLines.map(row => row.slice());
  if (line.orientation === 'h') newH[line.row][line.col] = 'sim';
  else newV[line.row][line.col] = 'sim';
  let boxesMade = 0;
  for (let r = 0; r < game.rows; r++) {
    for (let c = 0; c < game.cols; c++) {
      if (game.boxes[r][c] === null) {
        if (newH[r][c] !== null && newH[r+1][c] !== null && newV[r][c] !== null && newV[r][c+1] !== null) {
          boxesMade++;
        }
      }
    }
  }
  return { boxesMade, newH, newV };
}

function _dbAllLines(game) {
  const out = [];
  for (let r = 0; r <= game.rows; r++)
    for (let c = 0; c < game.cols; c++)
      if (game.hLines[r][c] === null) out.push({ orientation: 'h', row: r, col: c });
  for (let r = 0; r < game.rows; r++)
    for (let c = 0; c <= game.cols; c++)
      if (game.vLines[r][c] === null) out.push({ orientation: 'v', row: r, col: c });
  return out;
}

function dotsboxesMove(game, idx, agent) {
  if (!Array.isArray(game.hLines) || !Array.isArray(game.vLines)) return { fallback: true };
  const skill = (agent && agent.skill) || 3;
  const lines = _dbAllLines(game);
  if (lines.length === 0) return { fallback: true };

  // Blunder rate
  if (Math.random() < mistakeChance(skill)) {
    const pick = lines[Math.floor(Math.random() * lines.length)];
    return { action: { type: 'line', orientation: pick.orientation, row: pick.row, col: pick.col } };
  }

  // 1) Take any move that completes a box.
  const completing = [];
  for (const ln of lines) {
    const sim = _dbSimulateLine(game, ln);
    if (sim.boxesMade > 0) completing.push({ ln, boxes: sim.boxesMade });
  }
  if (completing.length > 0) {
    completing.sort((a, b) => b.boxes - a.boxes);
    const best = completing[0].ln;
    return { action: { type: 'line', orientation: best.orientation, row: best.row, col: best.col } };
  }

  // 2) Among non-completing moves, prefer "safe" ones — those that don't
  // give opponent a 3-sided box (i.e. don't push any box from 2->3 sides).
  const safe = [];
  const unsafe = [];
  for (const ln of lines) {
    const sim = _dbSimulateLine(game, ln);
    let createsThreat = false;
    for (let r = 0; r < game.rows; r++) {
      for (let c = 0; c < game.cols; c++) {
        if (game.boxes[r][c] !== null) continue;
        let n = 0;
        if (sim.newH[r][c] !== null) n++;
        if (sim.newH[r+1][c] !== null) n++;
        if (sim.newV[r][c] !== null) n++;
        if (sim.newV[r][c+1] !== null) n++;
        if (n === 3) { createsThreat = true; break; }
      }
      if (createsThreat) break;
    }
    if (createsThreat) unsafe.push(ln);
    else safe.push(ln);
  }

  if (safe.length > 0) {
    const pick = safe[Math.floor(Math.random() * safe.length)];
    return { action: { type: 'line', orientation: pick.orientation, row: pick.row, col: pick.col } };
  }

  // 3) Forced into giving boxes — pick the move that gives the SHORTEST chain
  // (approximated by counting how many 3-sided boxes the move creates;
  // opponent will only get to claim that many in their next turn unless they
  // can chain). Simple heuristic: prefer move that creates fewest 3-side boxes.
  let bestPick = unsafe[0];
  let bestThreats = Infinity;
  for (const ln of unsafe) {
    const sim = _dbSimulateLine(game, ln);
    let threats = 0;
    for (let r = 0; r < game.rows; r++) {
      for (let c = 0; c < game.cols; c++) {
        if (game.boxes[r][c] !== null) continue;
        let n = 0;
        if (sim.newH[r][c] !== null) n++;
        if (sim.newH[r+1][c] !== null) n++;
        if (sim.newV[r][c] !== null) n++;
        if (sim.newV[r][c+1] !== null) n++;
        if (n === 3) threats++;
      }
    }
    if (threats < bestThreats) { bestThreats = threats; bestPick = ln; }
  }
  return { action: { type: 'line', orientation: bestPick.orientation, row: bestPick.row, col: bestPick.col } };
}

// ──────────────────────────────────────────────────────────────
// HEX — shortest connection-path heuristic (Dijkstra-like)
// ──────────────────────────────────────────────────────────────
//
// Player 0 connects left edge (col 0) to right edge (col SIZE-1).
// Player 1 connects top edge (row 0) to bottom edge (row SIZE-1).
// For each empty cell, compute: cost to connect my edges through it
// (1 per empty cell on the path, 0 per my own stone, infinity per opponent).
// Pick the cell that maximally reduces my path AND increases opponent's.

function _hexNeighbors(r, c, size) {
  const dirs = [[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0]];
  const out = [];
  for (const [dr, dc] of dirs) {
    const nr = r + dr, nc = c + dc;
    if (nr >= 0 && nr < size && nc >= 0 && nc < size) out.push([nr, nc]);
  }
  return out;
}

function _hexShortestPath(board, size, player) {
  // BFS-like Dijkstra with binary weights (0 if my stone, 1 if empty, blocked if opp).
  // For player 0: source = all cells in col 0 not blocked by opp; target = col size-1.
  // For player 1: source = all cells in row 0; target = row size-1.
  const dist = Array.from({ length: size }, () => Array(size).fill(Infinity));
  // Use a simple 0-1 BFS with two-ended queue
  const deque = [];
  if (player === 0) {
    for (let r = 0; r < size; r++) {
      if (board[r][0] === null) { dist[r][0] = 1; deque.push([r, 0]); }
      else if (board[r][0] === player) { dist[r][0] = 0; deque.unshift([r, 0]); }
    }
  } else {
    for (let c = 0; c < size; c++) {
      if (board[0][c] === null) { dist[0][c] = 1; deque.push([0, c]); }
      else if (board[0][c] === player) { dist[0][c] = 0; deque.unshift([0, c]); }
    }
  }
  while (deque.length > 0) {
    const [r, c] = deque.shift();
    for (const [nr, nc] of _hexNeighbors(r, c, size)) {
      const cell = board[nr][nc];
      if (cell !== null && cell !== player) continue;
      const w = cell === player ? 0 : 1;
      if (dist[r][c] + w < dist[nr][nc]) {
        dist[nr][nc] = dist[r][c] + w;
        if (w === 0) deque.unshift([nr, nc]);
        else deque.push([nr, nc]);
      }
    }
  }
  let minDist = Infinity;
  if (player === 0) {
    for (let r = 0; r < size; r++) if (dist[r][size - 1] < minDist) minDist = dist[r][size - 1];
  } else {
    for (let c = 0; c < size; c++) if (dist[size - 1][c] < minDist) minDist = dist[size - 1][c];
  }
  return minDist;
}

function hexMove(game, idx, agent) {
  if (!Array.isArray(game.board)) return { fallback: true };
  const board = game.board;
  const size = game.board.length;
  const opp = 1 - idx;
  const skill = (agent && agent.skill) || 3;

  const empties = [];
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      if (board[r][c] === null) empties.push({ row: r, col: c });
  if (empties.length === 0) return { fallback: true };

  if (Math.random() < mistakeChance(skill)) {
    // Prefer the center area
    empties.sort((a, b) => Math.abs(a.row - size/2) + Math.abs(a.col - size/2) -
                            (Math.abs(b.row - size/2) + Math.abs(b.col - size/2)));
    const pool = empties.slice(0, Math.max(1, Math.floor(empties.length / 3)));
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return { action: { type: 'place', row: pick.row, col: pick.col } };
  }

  // For each empty cell, simulate placing my stone there and compute
  // my shortest path vs opp's shortest path. Pick the cell that minimizes
  // (myPath - oppPath).
  let best = empties[0];
  let bestScore = Infinity;
  // Limit candidates for performance — top 25 cells near the action
  const sampled = empties.length <= 25 ? empties :
    empties.sort((a, b) => Math.abs(a.row - size/2) + Math.abs(a.col - size/2) -
                            (Math.abs(b.row - size/2) + Math.abs(b.col - size/2))).slice(0, 25);

  for (const m of sampled) {
    board[m.row][m.col] = idx;
    const myDist = _hexShortestPath(board, size, idx);
    const oppDist = _hexShortestPath(board, size, opp);
    board[m.row][m.col] = null;
    const score = myDist - oppDist * 0.85; // weight my offense slightly more
    if (score < bestScore) { bestScore = score; best = m; }
  }
  return { action: { type: 'place', row: best.row, col: best.col } };
}

// ──────────────────────────────────────────────────────────────
// CHECKERS — minimax depth 3-5 with material + king bonus
// ──────────────────────────────────────────────────────────────

function _checkersAllMoves(game, player) {
  // Build (from, to) candidate single-step moves. Honor mustJumpFrom and
  // forced captures.
  const moves = [];
  if (game.mustJumpFrom !== null) {
    const piece = game.board[game.mustJumpFrom];
    if (piece && piece.player === player) {
      const jumps = game._getJumps(game.mustJumpFrom, piece);
      for (const j of jumps) moves.push({ from: game.mustJumpFrom, to: j.to });
    }
    return moves;
  }
  const hasJumps = game._playerHasJumps(player);
  for (let i = 0; i < 64; i++) {
    const p = game.board[i];
    if (!p || p.player !== player) continue;
    if (hasJumps) {
      const js = game._getJumps(i, p);
      for (const j of js) moves.push({ from: i, to: j.to });
    } else {
      const ms = game._getMoves(i, p);
      for (const t of ms) moves.push({ from: i, to: t });
    }
  }
  return moves;
}

function _checkersEval(game, me) {
  let myScore = 0, oppScore = 0;
  for (let i = 0; i < 64; i++) {
    const p = game.board[i];
    if (!p) continue;
    const val = p.king ? 3 : 1;
    const r = Math.floor(i / 8);
    // Bonus for advancing toward king row
    const advance = p.player === 0 ? (7 - r) * 0.05 : r * 0.05;
    if (p.player === me) myScore += val + advance;
    else oppScore += val + advance;
  }
  return myScore - oppScore;
}

function _checkersMinimax(game, current, me, depth, alpha, beta) {
  if (game.gameOver) {
    if (game.winner === me) return 1000;
    if (game.winner === null) return 0;
    return -1000;
  }
  if (depth === 0) return _checkersEval(game, me);

  const moves = _checkersAllMoves(game, current);
  if (moves.length === 0) return current === me ? -1000 : 1000;

  const isMax = (current === me);
  let best = isMax ? -Infinity : Infinity;
  for (const m of moves) {
    // Simulate
    const piece = game.board[m.from];
    const captured = [];
    // Detect jump: distance > 1 square
    const fr = Math.floor(m.from / 8), fc = m.from % 8;
    const tr = Math.floor(m.to / 8),   tc = m.to % 8;
    const isJump = Math.abs(tr - fr) === 2;
    const midPos = isJump ? ((fr + tr) / 2) * 8 + ((fc + tc) / 2) : null;
    if (isJump) { captured.push({ pos: midPos, piece: game.board[midPos] }); game.board[midPos] = null; }
    game.board[m.to] = piece;
    game.board[m.from] = null;
    const wasKing = piece.king;
    if (!piece.king) {
      if ((piece.player === 0 && tr === 0) || (piece.player === 1 && tr === 7)) piece.king = true;
    }

    const nextPlayer = isJump && game._getJumps(m.to, piece).length > 0 ? current : 1 - current;
    const score = _checkersMinimax(game, nextPlayer, me, depth - 1, alpha, beta);

    // Undo
    game.board[m.from] = piece;
    game.board[m.to] = null;
    if (!wasKing) piece.king = false;
    for (const cap of captured) game.board[cap.pos] = cap.piece;

    if (isMax) { if (score > best) best = score; alpha = Math.max(alpha, best); }
    else       { if (score < best) best = score; beta  = Math.min(beta,  best); }
    if (alpha >= beta) break;
  }
  return best;
}

function checkersMove(game, idx, agent) {
  if (!Array.isArray(game.board) || typeof game._getJumps !== 'function') return { fallback: true };
  const skill = (agent && agent.skill) || 3;
  const moves = _checkersAllMoves(game, idx);
  if (moves.length === 0) return { fallback: true };

  // Low skill: random move (still must take forced jump if any)
  if (Math.random() < mistakeChance(skill)) {
    const pick = moves[Math.floor(Math.random() * moves.length)];
    return { action: { type: 'move', from: pick.from, to: pick.to } };
  }

  // HARD MODE depth: skill 3 -> 6, skill 4 -> 7, skill 5 -> 8
  const depth = Math.max(4, skill + 3);
  let bestMove = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    // Simulate one ply, recurse with remaining depth
    const piece = game.board[m.from];
    const fr = Math.floor(m.from / 8), fc = m.from % 8;
    const tr = Math.floor(m.to / 8),   tc = m.to % 8;
    const isJump = Math.abs(tr - fr) === 2;
    const captured = [];
    const midPos = isJump ? ((fr + tr) / 2) * 8 + ((fc + tc) / 2) : null;
    if (isJump) { captured.push({ pos: midPos, piece: game.board[midPos] }); game.board[midPos] = null; }
    game.board[m.to] = piece;
    game.board[m.from] = null;
    const wasKing = piece.king;
    if (!piece.king && ((piece.player === 0 && tr === 0) || (piece.player === 1 && tr === 7))) piece.king = true;
    const nextPlayer = isJump && game._getJumps(m.to, piece).length > 0 ? idx : 1 - idx;
    const score = _checkersMinimax(game, nextPlayer, idx, depth - 1, -Infinity, Infinity);
    game.board[m.from] = piece;
    game.board[m.to] = null;
    if (!wasKing) piece.king = false;
    for (const cap of captured) game.board[cap.pos] = cap.piece;
    if (score > bestScore) { bestScore = score; bestMove = m; }
  }
  return { action: { type: 'move', from: bestMove.from, to: bestMove.to } };
}

// ──────────────────────────────────────────────────────────────
// CHESS — greedy capture + don't-blunder + center preference
// ──────────────────────────────────────────────────────────────
//
// Full chess minimax is too risky to implement correctly without extensive
// testing. Instead: avoid hanging pieces, take any free piece, prefer
// development. Far better than picking the first legal move.

const PIECE_VAL = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 20000 };

function _chessAllMoves(game, player) {
  const out = [];
  for (let i = 0; i < 64; i++) {
    const p = game.board[i];
    if (p && p.player === player) {
      const tos = game._getLegalMoves(i);
      for (const to of tos) out.push({ from: i, to });
    }
  }
  return out;
}

function chessMove(game, idx, agent) {
  if (!Array.isArray(game.board) || typeof game._getLegalMoves !== 'function') return { fallback: true };
  const skill = (agent && agent.skill) || 3;
  const opp = 1 - idx;
  const moves = _chessAllMoves(game, idx);
  if (moves.length === 0) return { fallback: true };

  if (Math.random() < mistakeChance(skill)) {
    const pick = moves[Math.floor(Math.random() * moves.length)];
    return { action: { type: 'move', from: pick.from, to: pick.to } };
  }

  // Score each move with shallow lookahead: my move minus opp's best reply.
  function pieceVal(p) { return p ? PIECE_VAL[p.type] : 0; }

  let bestMove = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const captured = game.board[m.to];
    const captureGain = pieceVal(captured);
    // Tentatively make the move
    const moving = game.board[m.from];
    game.board[m.to] = moving;
    game.board[m.from] = null;

    // What is the most valuable piece opponent can capture in response?
    let oppBest = 0;
    try {
      const oppMoves = _chessAllMoves(game, opp);
      for (const om of oppMoves) {
        const t = game.board[om.to];
        if (t && t.player === idx) {
          const v = PIECE_VAL[t.type];
          if (v > oppBest) oppBest = v;
        }
      }
    } catch (_) { /* keep going */ }

    // Restore
    game.board[m.from] = moving;
    game.board[m.to] = captured;

    // Heuristic bonus for central squares & development in opening
    const tr = Math.floor(m.to / 8), tc = m.to % 8;
    const centerBonus = (3.5 - Math.abs(tr - 3.5) - Math.abs(tc - 3.5)) * 2; // 7 best, 0 worst
    const score = captureGain - oppBest * 0.85 + centerBonus * 0.5;

    if (score > bestScore) { bestScore = score; bestMove = m; }
  }
  return { action: { type: 'move', from: bestMove.from, to: bestMove.to } };
}

// ──────────────────────────────────────────────────────────────
// BACKGAMMON — pip count + blot avoidance
// ──────────────────────────────────────────────────────────────

function backgammonMove(game, idx, agent) {
  // The game expects:
  //   - { type: 'roll' } if !diceRolled
  //   - { type: 'move', from, to, die } per move within turn
  if (!game.diceRolled) {
    return { action: { type: 'roll' } };
  }
  if (typeof game._getValidMoves !== 'function') return { fallback: true };
  const moves = game._getValidMoves(idx);
  if (!moves || moves.length === 0) return { fallback: true };
  const skill = (agent && agent.skill) || 3;

  if (Math.random() < mistakeChance(skill)) {
    const pick = moves[Math.floor(Math.random() * moves.length)];
    return { action: { type: 'move', from: pick.from, to: pick.to, die: pick.die } };
  }

  // Score each candidate by pip-count delta + blot penalty.
  // We don't know the game's internal point structure precisely, so this is
  // a coarse heuristic: pip distance from start to bear-off direction.
  const isP0 = idx === 0;
  const direction = isP0 ? -1 : 1;
  let best = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    // Pip gain = distance moved in our direction
    const pipGain = Math.abs(m.to - m.from);
    // Tiny blot bonus: prefer 'to' that ISN'T a single point (we don't know,
    // so just prefer moves that go further in our direction)
    const score = pipGain * direction * direction + (Math.random() * 0.5);
    if (score > bestScore) { bestScore = score; best = m; }
  }
  return { action: { type: 'move', from: best.from, to: best.to, die: best.die } };
}

// ──────────────────────────────────────────────────────────────
// Dispatch
// ──────────────────────────────────────────────────────────────

function strategyMove(gameType, game, idx, agent) {
  try {
    switch (gameType) {
      case 'morpion':    return morpionMove(game, idx, agent);
      case 'tictactoe':  return tttMove(game, idx, agent);
      case 'connect4':   return c4Move(game, idx, agent);
      case 'nim':        return nimMove(game, idx, agent);
      case 'reversi':    return reversiMove(game, idx, agent);
      case 'memory':     return memoryMove(game, idx, agent);
      case 'battleship': return battleshipMove(game, idx, agent);
      case 'mancala':    return mancalaMove(game, idx, agent);
      case 'dotsboxes':  return dotsboxesMove(game, idx, agent);
      case 'hex':        return hexMove(game, idx, agent);
      case 'checkers':   return checkersMove(game, idx, agent);
      case 'chess':      return chessMove(game, idx, agent);
      case 'backgammon': return backgammonMove(game, idx, agent);
      default:           return { fallback: true };
    }
  } catch (e) {
    console.warn('houseStrategy error for', gameType, '-', e.message);
    return { fallback: true };
  }
}

module.exports = { strategyMove };
